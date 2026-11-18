from datetime import timezone

from access_requests import request_page
from activity_log import ACTIVITY_CATEGORIES
from auth import get_database, read_json_object, read_page, require_admin
from bson import ObjectId
from divisions import serialize_division
from documents import page_response
from flask import Blueprint, jsonify, request
from metadata_fields import definitions
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError
from search_documents import search_matches
from werkzeug.exceptions import BadRequest

admin = Blueprint("admin", __name__, url_prefix="/api/admin")


@admin.errorhandler(PyMongoError)
def admin_unavailable(error):
    return jsonify(error="Administration is temporarily unavailable."), 503


@admin.get("/divisions")
@require_admin
def list_divisions():
    rows = get_database().divisions.find().sort("name_key", 1)
    return jsonify(divisions=[serialize_division(row) for row in rows])


@admin.post("/divisions")
@admin.patch("/divisions/<identifier>")
@require_admin
def save_division(identifier=None):
    data = read_json_object()
    changes = {}
    if identifier is None or "name" in data:
        name = data.get("name")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
            return jsonify(error="Enter a division name of 1–80 characters."), 400
        name = name.strip()
        try:
            name.encode("utf-8")
        except UnicodeEncodeError:
            return jsonify(error="Enter a valid UTF-8 division name."), 400
        changes = {"name": name, "name_key": name.casefold()}

    if "active" in data:
        if type(data["active"]) is not bool:
            return jsonify(error="Active must be true or false."), 400
        changes["active"] = data["active"]

    if not changes:
        return jsonify(error="Specify a name or active status to update."), 400

    collection = get_database().divisions
    try:
        if identifier is None:
            row = {"_id": str(ObjectId()), "active": True, **changes}
            collection.insert_one(row)
        else:
            row = collection.find_one_and_update(
                {"_id": identifier}, {"$set": changes}, return_document=ReturnDocument.AFTER
            )
            if row is None:
                return jsonify(error="Division not found."), 404
    except DuplicateKeyError:
        return jsonify(error="That division name is already in use."), 409

    return jsonify(division=serialize_division(row)), 201 if identifier is None else 200


def division_scope():
    identifier = request.args.get("division_id", "")
    return {"owner_division_id": identifier} if identifier else {}


@admin.get("/documents")
@require_admin
def list_documents():
    filters = division_scope()
    fields = definitions()
    if "q" in request.args:
        try:
            filters.update(search_matches(request.args["q"], request.args.get("scope", "all"), fields))
        except BadRequest as error:
            return jsonify(error=error.description), 400
    return page_response(filters, fields)


@admin.get("/requests")
@require_admin
def list_requests():
    return request_page(division_scope(), "incoming")


@admin.get("/activity")
@require_admin
def list_activity():
    try:
        page = read_page()
    except ValueError:
        return jsonify(error="Page must be between 1 and 10000."), 400
    query = {}
    category = request.args.get("category", "")
    if category:
        if category not in ACTIVITY_CATEGORIES:
            return jsonify(error="Choose a valid activity category."), 400
        query["action"] = {"$in": ACTIVITY_CATEGORIES[category]}
    if request.args.get("action"):
        action = request.args["action"]
        query = {"$and": [query, {"action": action}]}
    rows = list(
        get_database()
        .activity_log.find(query)
        .max_time_ms(2000)
        .sort([("created_at", -1), ("_id", -1)])
        .skip((page - 1) * 25)
        .limit(26)
    )
    entries = [
        {
            "id": str(row["_id"]),
            "action": row["action"],
            "actor": row["actor"],
            "division": row["division"],
            "details": row["details"],
            "created_at": row["created_at"].replace(tzinfo=timezone.utc).isoformat(),
        }
        for row in rows[:25]
    ]
    counts = {
        row["_id"]: row["count"]
        for row in get_database().activity_log.aggregate(
            [
                {
                    "$match": {
                        "action": {"$in": ["account_registered", "document_uploaded", "access_approved"]}
                    }
                },
                {"$group": {"_id": "$action", "count": {"$sum": 1}}},
            ],
            maxTimeMS=2000,
        )
    }
    statistics = {
        "accounts": counts.get("account_registered", 0),
        "uploads": counts.get("document_uploaded", 0),
        "approvals": counts.get("access_approved", 0),
    }
    return jsonify(entries=entries, page=page, has_more=len(rows) > 25, statistics=statistics)
