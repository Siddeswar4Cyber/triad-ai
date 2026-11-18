import re

from auth import get_database, require_user
from documents import filter_for, page_response
from flask import Blueprint, g, jsonify, request
from metadata_fields import definitions
from pymongo.errors import PyMongoError
from werkzeug.exceptions import BadRequest

search = Blueprint("search", __name__, url_prefix="/api")


@search.errorhandler(PyMongoError)
def search_unavailable(error):
    return jsonify(error="Document search is temporarily unavailable."), 503


def metadata_matches(fields, pattern, regex):
    # Older documents can contain numbers or booleans in free-text metadata.
    # Convert these values before applying the escaped search expression.
    matches = [
        {
            "$expr": {
                "$anyElementTrue": [
                    {
                        "$map": {
                            "input": {"$objectToArray": {"$ifNull": ["$metadata", {}]}},
                            "as": "item",
                            "in": {
                                "$regexMatch": {
                                    "input": {
                                        "$convert": {
                                            "input": "$$item.v",
                                            "to": "string",
                                            "onError": "",
                                            "onNull": "",
                                        }
                                    },
                                    "regex": pattern,
                                    "options": "i",
                                }
                            },
                        }
                    }
                ]
            }
        }
    ]
    for field in fields:
        if field["type"] == "text":
            matches.append({"metadata_fields." + field["key"]: regex})
        else:
            for option in field["options"]:
                if re.search(pattern, option["label"], re.IGNORECASE):
                    matches.append(filter_for(field, option["id"]))
    return matches


def search_matches(query, scope, fields):
    query = query.strip()
    if not 1 <= len(query) <= 100 or "\0" in query:
        raise BadRequest("Enter a search query of 1–100 characters.")

    if scope not in ("all", "title", "metadata", "text"):
        raise BadRequest("Choose all fields, titles, metadata, or extracted text.")

    pattern = re.escape(query)
    regex = {"$regex": pattern, "$options": "i"}
    matches = []
    if scope in ("all", "title"):
        matches.append({"title": regex})
    if scope in ("all", "text"):
        matches.append({"ocr_status": "ready", "ocr_text": regex})
    if scope in ("all", "metadata"):
        matches.extend(metadata_matches(fields, pattern, regex))

    return {"$or": matches}


@search.get("/search")
@require_user
def search_documents():
    fields = definitions()
    try:
        matches = search_matches(request.args.get("q", ""), request.args.get("scope", "all"), fields)
    except BadRequest as error:
        return jsonify(error=error.description), 400
    # Apply access restrictions in MongoDB before pagination to avoid leaking matches.
    approved_ids = get_database().access_requests.distinct(
        "document_id", {"requester_id": g.user["_id"], "status": "approved"}
    )
    access = {
        "$or": [
            {"owner_division_id": g.user["division_id"]},
            {"_id": {"$in": approved_ids}},
        ]
    }
    return page_response({"$and": [access, matches]}, fields)
