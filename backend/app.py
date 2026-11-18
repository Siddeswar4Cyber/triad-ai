import os

import click
from access_requests import access, init_access_indexes
from activity_log import log_response
from admin import admin
from auth import auth, get_database, init_auth_indexes
from documents import documents
from flask import Flask, jsonify
from metadata_fields import metadata_api, promote_admin, seed_metadata
from ocr_worker import backfill
from pymongo import MongoClient
from pymongo.errors import PyMongoError
from search_documents import search


def create_app():
    app = Flask(__name__)
    mongo = MongoClient(
        os.environ["MONGODB_URI"],
        connect=False,
        timeoutMS=3000,
    )
    database_name = os.getenv("MONGODB_DATABASE", "triad_dms")
    app.extensions["triad_db"] = mongo[database_name]
    app.after_request(log_response)
    app.register_blueprint(auth)
    app.register_blueprint(admin)
    app.register_blueprint(documents)
    app.register_blueprint(metadata_api)
    app.register_blueprint(access)
    app.register_blueprint(search)
    app.cli.command("init-access")(init_access_indexes)
    app.cli.command("init-auth")(init_auth_indexes)
    app.cli.command("init-metadata")(seed_metadata)
    app.cli.command("promote-admin")(click.argument("email")(promote_admin))

    @app.cli.command("backfill-ocr")
    def backfill_ocr():
        click.echo(f"Queued {backfill(get_database())} existing document(s).")

    @app.get("/api/health")
    def health_check():
        try:
            mongo.admin.command("ping")
        except PyMongoError as error:
            app.logger.warning("MongoDB health check failed: %s", error)
            return jsonify(status="degraded", mongodb="unavailable"), 503

        return jsonify(status="ok", mongodb="connected"), 200

    return app
