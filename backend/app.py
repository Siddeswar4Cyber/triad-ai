import os  # noqa: I001

from flask import Flask, jsonify
from pymongo import MongoClient
from pymongo.errors import PyMongoError

from auth import auth, init_auth_indexes
from documents import documents

def create_app():
    app = Flask(__name__)
    mongo = MongoClient(
        os.environ["MONGODB_URI"],
        connect=False,
        timeoutMS=3000,
    )
    database_name = os.getenv("MONGODB_DATABASE", "triad_dms")
    app.extensions["triad_db"] = mongo[database_name]
    app.register_blueprint(auth)
    app.register_blueprint(documents)
    app.cli.command("init-auth")(init_auth_indexes)

    @app.get("/api/health")
    def health_check():
        try:
            mongo.admin.command("ping")
        except PyMongoError as e:
            app.logger.warning(
                "MongoDB health check failed: %s", str(e)
            )
            return jsonify(status="degraded", mongodb="unavailable"), 503

        return jsonify(status="ok", mongodb="connected"), 200

    return app
