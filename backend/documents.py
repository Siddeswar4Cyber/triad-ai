import json
import math
from datetime import datetime, timezone
from pathlib import PurePosixPath

from bson import ObjectId
from flask import Blueprint, current_app, g, jsonify, request
from gridfs import GridFSBucket
from PIL import Image
from pymongo.errors import PyMongoError
from pypdf import PdfReader
from pypdf.errors import PdfReadError
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

from auth import DIVISIONS, get_database, require_user
from metadata_fields import definitions, validate_values


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
