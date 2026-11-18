import re
from uuid import uuid4

import click
from activity_log import record_event
from auth import get_database, read_json_object, require_user
from flask import Blueprint, g, jsonify, request
from pymongo.errors import DuplicateKeyError, PyMongoError

metadata_api = Blueprint("metadata", __name__, url_prefix="/api/metadata-fields")
KEY = re.compile(r"[a-z][a-z0-9_]{0,39}")
RESERVED = {"division", "division_id", "owner_division_id", "page", "q", "file", "metadata"}


def seed_metadata():
    get_database().metadata_fields.update_one(
        {"_id": "report_type"},
        {
            "$setOnInsert": {
                "label": "Report Type",
                "type": "select",
                "required": False,
                "active": True,
                "aliases": ["Report Type"],
                "options": [
                    {"id": "financial", "label": "Financial", "active": True, "aliases": ["Financial"]},
                    {"id": "operational", "label": "Operational", "active": True, "aliases": ["Operational"]},
                ],
            }
        },
        upsert=True,
    )


def promote_admin(email):
    result = get_database().users.update_one({"email": email.strip().lower()}, {"$set": {"role": "admin"}})
    if not result.matched_count:
        raise click.ClickException("Account not found. Register it first.")
    record_event(
        "admin_promoted", {"email": "Docker CLI", "role": "system"}, {"account": email.strip().lower()}
    )
    click.echo("Account promoted. Sign in again to open Admin.")


def definitions(active_only=False):
    query = {"active": True} if active_only else {}
    return [
        {"key": row.pop("_id"), **row} for row in get_database().metadata_fields.find(query).sort("_id", 1)
    ]


def option_for(field, value):
    return next(
        (
            option
            for option in field["options"]
            if value == option["id"] or value == option["label"] or value in option.get("aliases", [])
        ),
        None,
    )


def field_names(field):
    return {field["key"], field["label"], *field.get("aliases", [])}


def validate_values(values, fields):
    result = {}
    for field in fields:
        supplied = [key for key in values if key in field_names(field)]
        if len(supplied) > 1:
            raise ValueError(f"Supply {field['label']} only once.")
        value = values.pop(supplied[0]) if supplied else None
        if value is None or value == "":
            if field["required"]:
                raise ValueError(f"{field['label']} is required.")
            continue
        if field["type"] == "select":
            option = option_for(field, value)
            if not option or not option["active"]:
                raise ValueError(f"Choose an active option for {field['label']}.")
            value = option["id"]
        elif not isinstance(value, str) or not value.strip():
            raise ValueError(f"{field['label']} must contain text.")
        result[field["key"]] = value
    if values:
        raise ValueError("Metadata contains an unknown or retired field.")
    return result


def display_values(row, fields):
    values = dict(row.get("metadata", {}))
    for field in fields:
        for key in field_names(field):
            if key in row.get("metadata_fields", {}):
                value = row["metadata_fields"][key]
                break
            if key in values:
                value = values[key]
                break
        else:
            continue
        for key in field_names(field):
            values.pop(key, None)
        option = option_for(field, value)
        values[field["label"]] = option["label"] if option else value
    return values


def label(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 80:
        raise ValueError("Labels must contain 1–80 characters.")
    value = value.strip()
    value.encode("utf-8")
    if any(char in value for char in ".$\0") or value.casefold() in RESERVED:
        raise ValueError("That label is reserved or contains an invalid character.")
    return value


def flag(data, key, default):
    value = data.get(key, default)
    if not isinstance(value, bool):
        raise ValueError(f"{key} must be true or false.")
    return value


def aliases(original, name):
    history = sorted({*original.get("aliases", []), original.get("label", name)})
    if len(history) > 100:
        raise ValueError("This item has reached its label history limit.")
    return history


@metadata_api.errorhandler(PyMongoError)
def unavailable(error):
    return jsonify(error="Metadata storage is temporarily unavailable."), 503


@metadata_api.get("")
@require_user
def list_fields():
    admin = g.user["role"] == "admin" and request.args.get("all") == "1"
    fields = definitions(active_only=not admin)
    if not admin:
        for field in fields:
            field["options"] = [option for option in field["options"] if option["active"]]
    return jsonify(fields=fields)


@metadata_api.post("/report_type/options")
@require_user
def add_report_type():
    try:
        name = label(read_json_object().get("label"))
    except (ValueError, UnicodeError) as error:
        return jsonify(error=str(error)), 400
    collection = get_database().metadata_fields
    for _ in range(3):
        field = collection.find_one({"_id": "report_type", "active": True, "type": "select"})
        if field is None:
            return jsonify(error="Report Type is unavailable."), 404
        existing = next(
            (
                option
                for option in field["options"]
                if name.casefold()
                in {value.casefold() for value in (option["label"], *option.get("aliases", []))}
            ),
            None,
        )
        if existing:
            if not existing["active"]:
                return jsonify(error="This report type is retired. Choose another name."), 400
            return jsonify(option=existing), 200
        if len(field["options"]) >= 100:
            return jsonify(error="Report Type has reached its 100-choice limit."), 400
        option = {"id": uuid4().hex, "label": name, "active": True, "aliases": []}
        # Match the previous definition so concurrent additions cannot duplicate labels.
        if collection.update_one(field, {"$push": {"options": option}}).matched_count:
            return jsonify(option=option), 201
    return jsonify(error="Report types changed. Please try again."), 409


@metadata_api.post("")
@metadata_api.patch("/<key>")
@require_user
def save_field(key=None):
    if g.user["role"] != "admin":
        return jsonify(error="Managing metadata fields requires an administrator."), 403
    collection = get_database().metadata_fields
    data = read_json_object()
    old = collection.find_one({"_id": key}) if key is not None else None
    if key is not None and old is None:
        return jsonify(error="Field not found."), 404
    try:
        if old is None:
            key = data.get("key")
            if not isinstance(key, str) or not KEY.fullmatch(key) or key in RESERVED:
                raise ValueError("Use a lowercase field key with letters, digits, and underscores.")
        elif "key" in data and data["key"] != key:
            raise ValueError("Field keys cannot be changed.")
        previous = old or {}
        field_type = data.get("type", previous.get("type"))
        if field_type not in ("text", "select") or (old and field_type != old["type"]):
            raise ValueError("Choose text or select. Existing field types cannot be changed.")
        name = label(data.get("label", previous.get("label")))
        history = aliases(previous, name)
        existing = {option["id"]: option for option in previous.get("options", [])}
        options = dict(existing)
        supplied = data.get("options", [])
        if not isinstance(supplied, list) or len(supplied) > 100 or (field_type == "text" and supplied):
            raise ValueError("Select fields can have up to 100 choices.")
        seen = set()
        for item in supplied:
            if not isinstance(item, dict):
                raise ValueError("Each option must be an object.")
            option_id = item.get("id")
            if option_id is None:
                option_id = uuid4().hex
            elif not isinstance(option_id, str) or option_id not in existing or option_id in seen:
                raise ValueError("Use each existing option ID at most once.")
            seen.add(option_id)
            original = existing.get(option_id, {})
            option_name = label(item.get("label", original.get("label")))
            options[option_id] = {
                "id": option_id,
                "label": option_name,
                "active": flag(item, "active", original.get("active", True)),
                "aliases": aliases(original, option_name),
            }
        if len(options) > 100:
            raise ValueError("Select fields can have up to 100 choices.")
        used = set()
        for option in options.values():
            option_names = {option["label"], *option["aliases"]}
            if used & option_names:
                raise ValueError("Choice labels and historical labels must be unique.")
            used |= option_names
        active = flag(data, "active", previous.get("active", True))
        if active and field_type == "select" and not any(option["active"] for option in options.values()):
            raise ValueError("An active select field needs an active choice.")
        if any(field_names(field) & {key, name, *history} for field in definitions() if field["key"] != key):
            raise ValueError("Field keys and labels must be unique.")
        doc = {
            "label": name,
            "type": field_type,
            "required": flag(data, "required", previous.get("required", False)),
            "active": active,
            "options": list(options.values()),
            "aliases": history,
        }
        if old is None:
            collection.insert_one({"_id": key, **doc})
        elif not collection.replace_one(old, {"_id": key, **doc}).matched_count:
            return jsonify(error="The field changed. Fetch the latest definition and try again."), 409
    except (ValueError, UnicodeError) as error:
        return jsonify(error=str(error)), 400
    except DuplicateKeyError:
        return jsonify(error="That field key is already in use."), 409
    return jsonify(field={"key": key, **doc}), 200 if old else 201
