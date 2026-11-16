import json
import math
from datetime import datetime, timezone
from pathlib import PurePosixPath

from bson import ObjectId
from flask import Blueprint, Response, current_app, g, jsonify, request
from gridfs import GridFSBucket
from gridfs.errors import NoFile
from PIL import Image
from pymongo.errors import PyMongoError
from pypdf import PdfReader
from pypdf.errors import PdfReadError
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

from auth import DIVISIONS, get_database, require_user
from metadata_fields import definitions, display_values, names, option_for, validate_values


documents = Blueprint("documents", __name__, url_prefix="/api/documents")
MAX_FILE_BYTES = 10 * 1024 * 1024
IMAGE_TYPES = {"PNG": "image/png", "JPEG": "image/jpeg", "TIFF": "image/tiff", "WEBP": "image/webp"}


def read_metadata(raw, division_id):
    data = json.loads(raw)
    if not isinstance(data, dict) or len(data) > 50:
        raise ValueError("Metadata must be a JSON object with at most 50 fields.")

    metadata = {}
    for key, value in data.items():
        key = key.strip()
        key.encode("utf-8")
        if not key or len(key) > 80 or any(char in key for char in ".$\0") or key in metadata:
            raise ValueError("Metadata contains an invalid or duplicate field name.")
        if key.casefold() in {"division", "division_id", "owner_division_id"}:
            if value not in (division_id, DIVISIONS[division_id]):
                raise PermissionError("You can only upload to your own division.")
            continue
        if isinstance(value, str):
            value.encode("utf-8")
            if len(value) > 500:
                raise ValueError("Metadata text must be at most 500 characters.")
        elif type(value) is int:
            if not -(2 ** 63) <= value < 2 ** 63:
                raise ValueError("A metadata number is out of range.")
        elif type(value) is float:
            if not math.isfinite(value):
                raise ValueError("Metadata numbers must be finite.")
        elif type(value) is not bool:
            raise ValueError("Metadata values must be text, numbers, or true/false.")
        metadata[key] = value
    return metadata


def detect_content_type(stream):
    header = stream.read(5)
    stream.seek(0)
    if header == b"%PDF-":
        with PdfReader(stream, strict=True) as reader:
            if reader.is_encrypted or not len(reader.pages):
                raise ValueError("Choose an unencrypted PDF with at least one page.")
        stream.seek(0)
        return "application/pdf"

    with Image.open(stream, formats=list(IMAGE_TYPES)) as image:
        if image.width * image.height > 25_000_000:
            raise ValueError("Images must be at most 25 megapixels.")
        content_type = IMAGE_TYPES[image.format]
        image.verify()
    stream.seek(0)
    return content_type


@documents.errorhandler(RequestEntityTooLarge)
def upload_too_large(error):
    return jsonify(error="Choose a file at most 10 MiB."), 413


@documents.errorhandler(PyMongoError)
def storage_unavailable(error):
    current_app.logger.warning("Document storage failure: %s", type(error).__name__)
    return jsonify(error="Document storage is temporarily unavailable."), 503


@documents.post("/upload")
@require_user
def upload():
    request.max_content_length = MAX_FILE_BYTES + 128 * 1024
    division_id = g.user["division_id"]

    if request.mimetype != "multipart/form-data":
        return jsonify(error="Send the file as multipart form data."), 415

    files = request.files.getlist("file")
    if len(files) != 1 or not files[0].filename:
        return jsonify(error="Choose one PDF or image."), 400
    file = files[0]

    try:
        for carrier in (request.form, request.args):
            for key in ("Division", "division", "division_id", "owner_division_id"):
                if any(value not in (division_id, DIVISIONS[division_id]) for value in carrier.getlist(key)):
                    raise PermissionError("You can only upload to your own division.")
        metadata = validate_values(
            read_metadata(request.form.get("metadata", "{}"), division_id), definitions(active_only=True)
        )
    except PermissionError as error:
        return jsonify(error=str(error)), 403
    except (json.JSONDecodeError, UnicodeError, RecursionError):
        return jsonify(error="Metadata must be valid JSON with UTF-8 text."), 400
    except ValueError as error:
        return jsonify(error=str(error)), 400

    file.stream.seek(0, 2)
    size = file.stream.tell()
    file.stream.seek(0)
    if size > MAX_FILE_BYTES:
        raise RequestEntityTooLarge()
    if not size:
        return jsonify(error="The file is empty."), 400

    try:
        content_type = detect_content_type(file.stream)
    except (PdfReadError, OSError, ValueError, SyntaxError, TypeError, KeyError,
            OverflowError, RecursionError, Image.DecompressionBombError):
        return jsonify(error="Choose a readable, unencrypted PDF, PNG, JPEG, TIFF, or WebP."), 415

    filename = secure_filename(file.filename)[:255] or "document"
    db = get_database()
    bucket = GridFSBucket(db)
    file_id = ObjectId()
    record = {
        "_id": file_id,
        "gridfs_file_id": file_id,
        "owner_division_id": division_id,
        "uploaded_by": g.user["_id"],
        "filename": filename,
        "title": PurePosixPath(filename).stem,
        "content_type": content_type,
        "size": size,
        "metadata_fields": metadata,
        "created_at": datetime.now(timezone.utc),
    }

    try:
        bucket.upload_from_stream_with_id(file_id, filename, file.stream)
        db.documents.insert_one(record)
    except PyMongoError:
        # An insert timeout can leave a committed record. Check before deleting bytes.
        try:
            if db.documents.find_one({"_id": file_id}, {"_id": 1}) is None:
                bucket.delete(file_id)
        except PyMongoError:
            current_app.logger.warning("Could not reconcile upload %s", file_id)
        raise

    return jsonify(
        doc_id=str(file_id), filename=filename, title=record["title"],
        content_type=content_type, size=size, metadata=metadata,
        owner_division_id=division_id,
    ), 201


PAGE_SIZE = 20


def find_document(doc_id):
    if not ObjectId.is_valid(doc_id):
        return None
    return get_database().documents.find_one({"_id": ObjectId(doc_id)}, {"ocr_text": 0})


def can_read(row):
    return row["owner_division_id"] == g.user["division_id"]


def document_summary(row, fields):
    return {
        "doc_id": str(row["_id"]), "title": row["title"], "filename": row["filename"],
        "size": row["size"], "content_type": row["content_type"],
        "owner_division_id": row["owner_division_id"],
        "division": DIVISIONS[row["owner_division_id"]],
        "created_at": row["created_at"].replace(tzinfo=timezone.utc).isoformat(),
        "metadata": display_values(row, fields),
    }


def filter_for(field, value):
    option = option_for(field, value) if field["type"] == "select" else None
    current = option["id"] if option else value
    equivalent = list({value, current, option["label"], *option.get("aliases", [])}) if option else [value]
    return {"$or": [
        {"metadata_fields." + field["key"]: current},
        *[{"metadata." + name: {"$in": equivalent}} for name in names(field)],
    ]}


def page_response(query, fields):
    try:
        page = int(request.args.get("page", "1"))
        if not 1 <= page <= 10000:
            raise ValueError()
    except ValueError:
        return jsonify(error="Page must be between 1 and 10000."), 400

    rows = list(get_database().documents.find(query, {"ocr_text": 0})
                .sort([("created_at", -1), ("_id", -1)])
                .skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE + 1))
    return jsonify(documents=[document_summary(row, fields) for row in rows[:PAGE_SIZE]],
                   page=page, has_more=len(rows) > PAGE_SIZE)


@documents.get("")
@require_user
def list_documents():
    division = g.user["division_id"]
    fields = definitions()
    filters = [{"owner_division_id": division}]
    lookup = {name: field for field in fields for name in names(field)}
    for key, value in request.args.items():
        if not value or key == "page":
            continue
        if key.casefold() in {"division", "division_id", "owner_division_id"}:
            target = next((identifier for identifier, label in DIVISIONS.items()
                           if value in (identifier, label)), "")
            filters.append({"owner_division_id": target})
        elif key in lookup and len(value) <= 500:
            filters.append(filter_for(lookup[key], value))
        else:
            return jsonify(error="Unknown document filter or invalid value."), 400
    return page_response({"$and": filters}, fields)


@documents.get("/<doc_id>")
@require_user
def document_details(doc_id):
    row = find_document(doc_id)
    if row is None:
        return jsonify(error="Document not found."), 404
    if not can_read(row):
        return jsonify(document={"doc_id": doc_id, "division": DIVISIONS[row["owner_division_id"]],
                                 "can_download": False})
    return jsonify(document={**document_summary(row, definitions()), "can_download": True})


@documents.get("/<doc_id>/download")
@require_user
def download_document(doc_id):
    row = find_document(doc_id)
    if row is None or not can_read(row):
        return jsonify(error="Document not found or access unavailable."), 404
    try:
        stream = GridFSBucket(get_database()).open_download_stream(row["gridfs_file_id"])
    except NoFile:
        return jsonify(error="The stored file is unavailable."), 404

    def chunks():
        try:
            while chunk := stream.read(255 * 1024):
                yield chunk
        finally:
            stream.close()

    response = Response(chunks(), mimetype=row["content_type"])
    response.content_length = stream.length
    response.headers.set("Content-Disposition", "attachment", filename=row["filename"])
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.call_on_close(stream.close)
    return response
