import os  # noqa: I001

from flask import Flask, jsonify
from pymongo import MongoClient
from pymongo.errors import PyMongoError

def create_app():
    app = Flask(__name__)
    mongo = MongoClient(
        os.environ["MONGODB_URI"],
        connect=False,
        timeoutMS=3000,
    )

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
