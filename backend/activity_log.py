"""Record successful application actions without storing credentials or file contents."""

from datetime import datetime, timezone

from bson import ObjectId
from flask import current_app, g, request
from pymongo.errors import PyMongoError

EVENTS = {
    "auth.register": "account_registered",
    "auth.login": "signed_in",
    "auth.logout": "signed_out",
    "documents.upload": "document_uploaded",
    "documents.document_metadata": "document_metadata_updated",
    "documents.download_document": "document_downloaded",
    "access.request_access": "access_requested",
    "access.approve_access": "access_approved",
    "access.reject_access": "access_rejected",
    "admin.save_division": "division_updated",
    "metadata.save_field": "metadata_field_updated",
    "metadata.add_report_type": "report_type_added",
}

ACTIVITY_CATEGORIES = {
    "accounts": ["account_registered", "signed_in", "signed_out", "admin_promoted"],
    "documents": ["document_uploaded", "document_downloaded", "document_metadata_updated"],
    "requests": ["access_requested", "access_approved", "access_rejected"],
    "administration": ["division_created", "division_updated", "metadata_field_updated", "report_type_added"],
}


def init_activity_indexes(db):
    db.activity_log.create_index([("created_at", -1), ("_id", -1)])
    db.activity_log.create_index([("action", 1), ("created_at", -1), ("_id", -1)])


def record_event(action, actor, details):
    db = current_app.extensions["triad_db"]
    try:
        division = db.divisions.find_one({"_id": actor.get("division_id")}) or {}
        db.activity_log.insert_one(
            {
                "action": action,
                "created_at": datetime.now(timezone.utc),
                "actor": {
                    **{key: str(actor.get(key, "")) for key in ("email", "role", "division_id")},
                    "user_id": str(actor.get("_id", actor.get("id", ""))),
                },
                "division": division.get("name", ""),
                "details": details,
            }
        )
    except PyMongoError:
        current_app.logger.exception("Could not store activity event %s", action)


def log_response(response):
    action = EVENTS.get(request.endpoint)
    if not action or (request.method == "GET" and action != "document_downloaded"):
        return response
    if not 200 <= response.status_code < 300:
        return response
    # Repeated access submissions and report-type lookups are reads of existing records.
    if action in ("access_requested", "report_type_added") and response.status_code != 201:
        return response
    data = response.get_json(silent=True) if response.is_json else {}
    data = data or {}
    actor = getattr(g, "user", None) or data.get("user", {})
    db = current_app.extensions["triad_db"]
    details = {}
    if action == "document_uploaded":
        details = {
            key: data[key]
            for key in ("doc_id", "title", "filename", "content_type", "size", "owner_division_id")
            if key in data
        }
    elif action.startswith("access_"):
        entry = data.get("access_request", {})
        details = {key: entry[key] for key in ("request_id", "doc_id", "status", "division") if key in entry}
        try:
            row = db.access_requests.find_one({"_id": ObjectId(entry["request_id"])}) or {}
            user = db.users.find_one({"_id": row.get("requester_id")}) or {}
            doc = db.documents.find_one({"_id": row.get("document_id")}) or {}
            details.update(requester=user.get("email", ""), document=doc.get("title", ""))
        except (KeyError, ValueError, PyMongoError):
            current_app.logger.exception("Could not enrich access activity")
    elif action in ("document_metadata_updated", "document_downloaded"):
        identifier = request.view_args["doc_id"]
        try:
            doc = db.documents.find_one({"_id": ObjectId(identifier)}) or {}
            details = {
                "doc_id": identifier,
                "document": doc.get("title", ""),
                "owner_division_id": doc.get("owner_division_id", ""),
            }
            if action == "document_metadata_updated":
                details["fields"] = list((request.get_json(silent=True) or {}).get("metadata", {}))
        except PyMongoError:
            current_app.logger.exception("Could not enrich document activity")
    elif action == "division_updated":
        details = data.get("division", {})
        action = "division_created" if response.status_code == 201 else action
    elif action == "metadata_field_updated":
        details = {key: data["field"][key] for key in ("key", "label", "type", "active")}
    elif action == "report_type_added":
        details = {key: data["option"][key] for key in ("id", "label")}
    record_event(action, actor, details)
    return response
