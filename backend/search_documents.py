import re

from flask import Blueprint, g, jsonify, request
from pymongo.errors import PyMongoError

from auth import require_user
from documents import filter_for, page_response
from metadata_fields import definitions

search = Blueprint("search", __name__, url_prefix="/api")


@search.errorhandler(PyMongoError)
def search_unavailable(error):
    return jsonify(error="Document search is temporarily unavailable."), 503


@search.get("/search")
@require_user
def search_documents():
    query = request.args.get("q", "").strip()
    if not 1 <= len(query) <= 100 or "\0" in query:
        return jsonify(error="Enter a search query of 1–100 characters."), 400

    fields = definitions()
    pattern = re.escape(query)
    regex = {"$regex": pattern, "$options": "i"}
    matches = [
        {"title": regex},
        {"ocr_status": "ready", "ocr_text": regex},
        {"$expr": {"$anyElementTrue": [{"$map": {
            "input": {"$objectToArray": {"$ifNull": ["$metadata", {}]}},
            "as": "item",
            "in": {"$regexMatch": {
                "input": {"$convert": {"input": "$$item.v", "to": "string", "onError": "", "onNull": ""}},
                "regex": pattern, "options": "i",
            }},
        }}]}},
    ]
    for field in fields:
        if field["type"] == "text":
            matches.append({"metadata_fields." + field["key"]: regex})
        else:
            for option in field["options"]:
                if re.search(pattern, option["label"], re.IGNORECASE):
                    matches.append(filter_for(field, option["id"]))

    return page_response({"owner_division_id": g.user["division_id"], "$or": matches}, fields)
