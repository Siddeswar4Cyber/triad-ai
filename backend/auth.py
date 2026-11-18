import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone
from functools import wraps

import click
from divisions import division_name, init_divisions, serialize_division
from flask import Blueprint, current_app, g, jsonify, request
from pymongo.errors import DuplicateKeyError, PyMongoError
from werkzeug.security import check_password_hash, generate_password_hash

auth = Blueprint("auth", __name__, url_prefix="/api/auth")


SESSION_LIFETIME = timedelta(hours=8)
DUMMY_PASSWORD_HASH = generate_password_hash(secrets.token_urlsafe(32))
EMAIL_PATTERN = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")


def get_database():
    return current_app.extensions["triad_db"]


def public_user(user):
    return {
        "id": str(user["_id"]),
        "email": user["email"],
        "division_id": user["division_id"],
        "division": division_name(get_database(), user["division_id"]),
        "role": user["role"],
    }


def read_json_object():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def read_page():
    page = int(request.args.get("page", "1"))
    if not 1 <= page <= 10000:
        raise ValueError("Page must be between 1 and 10000.")
    return page


def read_credentials(data):
    email = data.get("email")
    password = data.get("password")

    if not isinstance(email, str) or not isinstance(password, str):
        return None

    email = email.strip().lower()
    if len(email) > 254 or EMAIL_PATTERN.fullmatch(email) is None:
        return None

    if not 8 <= len(password) <= 128:
        return None

    # JSON escapes can decode to lone surrogates, which UTF-8 cannot encode.
    try:
        email.encode("utf-8")
        password.encode("utf-8")
    except UnicodeEncodeError:
        return None

    return email, password


def token_digest(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def unauthorized(message):
    response = jsonify(error=message)
    response.headers["WWW-Authenticate"] = "Bearer"
    return response, 401


def require_user(view):
    @wraps(view)
    def protected_view(*args, **kwargs):
        scheme, _, token = request.headers.get("Authorization", "").partition(" ")
        if scheme.lower() != "bearer" or TOKEN_PATTERN.fullmatch(token) is None:
            return unauthorized("Sign in to continue.")

        db = get_database()
        session = db.auth_sessions.find_one(
            {
                "_id": token_digest(token),
                "expires_at": {"$gt": datetime.now(timezone.utc)},
            }
        )
        if session is None:
            return unauthorized("Your session is invalid or has expired.")

        user = db.users.find_one({"_id": session["user_id"]})
        if user is None:
            return unauthorized("Your session is invalid or has expired.")

        g.user = user
        g.auth_session_id = session["_id"]
        return view(*args, **kwargs)

    return protected_view


def require_admin(view):
    @require_user
    @wraps(view)
    def protected_view(*args, **kwargs):
        if g.user["role"] != "admin":
            return jsonify(error="Administrator access is required."), 403
        return view(*args, **kwargs)

    return protected_view


def init_auth_indexes():
    db = get_database()
    db.users.create_index("email", unique=True)
    db.auth_sessions.create_index("expires_at", expireAfterSeconds=0)
    init_divisions(db)
    click.echo("Authentication indexes and divisions are ready.")


@auth.errorhandler(PyMongoError)
def auth_database_error(error):
    current_app.logger.warning("Authentication database operation failed: %s", type(error).__name__)
    return jsonify(error="Authentication is temporarily unavailable."), 503


@auth.get("/divisions")
def list_divisions():
    rows = get_database().divisions.find({"active": True}).sort("name_key", 1)
    return jsonify(divisions=[serialize_division(row) for row in rows])


@auth.post("/register")
def register():
    data = read_json_object()
    credentials = read_credentials(data)
    if credentials is None:
        return jsonify(error="Enter a valid email and an 8–128 character password."), 400

    division_id = data.get("division_id")
    if (
        not isinstance(division_id, str)
        or get_database().divisions.find_one(
            {
                "_id": division_id,
                "active": True,
            }
        )
        is None
    ):
        return jsonify(error="Select a valid division."), 400

    email, password = credentials
    user = {
        "email": email,
        "password_hash": generate_password_hash(password),
        "division_id": division_id,
        "role": "user",
        "created_at": datetime.now(timezone.utc),
    }

    try:
        result = get_database().users.insert_one(user)
    except DuplicateKeyError:
        return jsonify(error="An account already exists for this email."), 409

    user["_id"] = result.inserted_id
    return jsonify(user=public_user(user)), 201


@auth.post("/login")
def login():
    credentials = read_credentials(read_json_object())
    if credentials is None:
        return unauthorized("Invalid email or password.")

    email, password = credentials
    db = get_database()
    user = db.users.find_one({"email": email})
    password_hash = user["password_hash"] if user else DUMMY_PASSWORD_HASH

    if not check_password_hash(password_hash, password) or user is None:
        return unauthorized("Invalid email or password.")

    token = secrets.token_urlsafe(32)
    db.auth_sessions.insert_one(
        {
            "_id": token_digest(token),
            "user_id": user["_id"],
            "expires_at": datetime.now(timezone.utc) + SESSION_LIFETIME,
        }
    )

    response = jsonify(token=token, user=public_user(user))
    response.headers["Cache-Control"] = "no-store"
    return response


@auth.get("/me")
@require_user
def get_current_user():
    response = jsonify(user=public_user(g.user))
    response.headers["Cache-Control"] = "no-store"
    return response


@auth.post("/logout")
@require_user
def logout():
    get_database().auth_sessions.delete_one({"_id": g.auth_session_id})
    return "", 204
