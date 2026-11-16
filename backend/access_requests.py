from datetime import datetime, timezone

from bson import ObjectId
from flask import Blueprint, g, jsonify, request
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

from auth import DIVISIONS, get_database, read_json_object, require_user
from documents import find_document

access = Blueprint("access", __name__, url_prefix="/api/access")


def init_access_indexes():
    db = get_database()
    db.access_requests.create_index([("document_id", 1), ("requester_id", 1)], unique=True)
    db.access_requests.create_index([("owner_division_id", 1), ("created_at", -1), ("_id", -1)])
    db.access_requests.create_index([("requester_id", 1), ("created_at", -1), ("_id", -1)])
    db.documents.create_index([("owner_division_id", 1), ("created_at", -1), ("_id", -1)])


def summary(row):
    return {
        "request_id": str(row["_id"]), "doc_id": str(row["document_id"]),
        "status": row["status"], "division": DIVISIONS[row["owner_division_id"]],
        "created_at": row["created_at"].replace(tzinfo=timezone.utc).isoformat(timespec="milliseconds"),
        "decided_at": row["decided_at"].replace(tzinfo=timezone.utc).isoformat(timespec="milliseconds") if row.get("decided_at") else None,
    }


@access.errorhandler(PyMongoError)
def unavailable(error):
    return jsonify(error="Access requests are temporarily unavailable."), 503


@access.post("/request")
@require_user
def request_access():
    doc_id = read_json_object().get("doc_id")
    row = find_document(doc_id)
    if row is None:
        return jsonify(error="Document not found."), 404
    if row["owner_division_id"] == g.user["division_id"]:
        return jsonify(error="You already have access through your division."), 400

    collection = get_database().access_requests
    identity = {"document_id": row["_id"], "requester_id": g.user["_id"]}
    record = {**identity, "owner_division_id": row["owner_division_id"],
              "status": "pending", "created_at": datetime.now(timezone.utc)}
    try:
        collection.insert_one(record)
    except DuplicateKeyError:
        existing = collection.find_one(identity)
        return jsonify(access_request=summary(existing)), 200
    return jsonify(access_request=summary(record)), 201


def decide(status):
    request_id = read_json_object().get("request_id")
    if not isinstance(request_id, str) or not ObjectId.is_valid(request_id):
        return jsonify(error="A valid request ID is required."), 400
    collection = get_database().access_requests
    identity = {"_id": ObjectId(request_id), "owner_division_id": g.user["division_id"]}
    row = collection.find_one_and_update(
        {**identity, "status": "pending"},
        {"$set": {"status": status, "decided_by": g.user["_id"], "decided_at": datetime.now(timezone.utc)}},
        return_document=ReturnDocument.AFTER,
    )
    if row is not None:
        return jsonify(access_request=summary(row))
    if collection.find_one(identity, {"_id": 1}) is not None:
        return jsonify(error="This request has already been decided."), 409
    return jsonify(error="Request not found."), 404


@access.post("/approve")
@require_user
def approve_access():
    return decide("approved")


@access.post("/reject")
@require_user
def reject_access():
    return decide("rejected")


@access.get("/requests")
@require_user
def list_requests():
    direction = request.args.get("direction", "incoming")
    if direction not in ("incoming", "outgoing"):
        return jsonify(error="Choose incoming or outgoing requests."), 400
    try:
        page = int(request.args.get("page", "1"))
        if not 1 <= page <= 10000:
            raise ValueError()
    except ValueError:
        return jsonify(error="Page must be between 1 and 10000."), 400

    db = get_database()
    identity = {"owner_division_id": g.user["division_id"]} if direction == "incoming" else {"requester_id": g.user["_id"]}
    rows = list(db.access_requests.find(identity)
                .sort([("created_at", -1), ("_id", -1)]).skip((page - 1) * 20).limit(21))
    entries = []
    for row in rows[:20]:
        entry = summary(row)
        if direction == "incoming":
            requester = db.users.find_one({"_id": row["requester_id"]}, {"email": 1, "division_id": 1})
            document = db.documents.find_one({"_id": row["document_id"], **identity}, {"title": 1})
            entry["requester"] = requester["email"] if requester else "Unavailable account"
            entry["requester_division"] = DIVISIONS[requester["division_id"]] if requester else None
            entry["title"] = document["title"] if document else "Unavailable document"
        entries.append(entry)
    return jsonify(requests=entries, has_more=len(rows) > 20, page=page)
