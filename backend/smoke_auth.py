"""Run the auth smoke test against an isolated database on the Compose MongoDB."""
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from werkzeug.security import check_password_hash

from app import create_app
from auth import token_digest


def expect_status(response, status):
    assert response.status_code == status, (
        f"{response.request.method} {response.request.path}: "
        f"expected HTTP {status}, got {response.status_code}"
    )
    return response.get_json(silent=True)


def run():
    os.environ["MONGODB_DATABASE"] = f"triad_auth_test_{uuid4().hex}"
    app = create_app()
    db = app.extensions["triad_db"]
    client = app.test_client()

    try:
        for _ in range(2):
            result = app.test_cli_runner().invoke(args=["init-auth"])
            assert result.exit_code == 0, result.output or str(result.exception)

        assert db.users.index_information()["email_1"]["unique"]
        assert db.auth_sessions.index_information()["expires_at_1"]["expireAfterSeconds"] == 0
        expect_status(client.get("/api/health"), 200)
        divisions = expect_status(client.get("/api/auth/divisions"), 200)["divisions"]
        assert {division["id"] for division in divisions} == {"division-a", "division-b"}
        expect_status(client.get("/api/auth/me"), 401)

        def register(**fields):
            return client.post("/api/auth/register", json=fields)

        def login(email, password):
            return client.post("/api/auth/login", json={"email": email, "password": password})

        password = "Component2-Test-42"
        for division in ("division-a", "division-b"):
            email = f"{division}@example.test"
            credentials = {"email": email, "password": password, "division_id": division}
            expect_status(register(**{**credentials, "division_id": "invalid"}), 400)
            expect_status(register(**{**credentials, "password": password + chr(0xd800)}), 400)
            expect_status(register(**{**credentials, "email": chr(0xd800) + email}), 400)

            user = expect_status(register(**credentials, role="admin"), 201)["user"]
            assert user["role"] == "user" and user["division_id"] == division
            assert "password_hash" not in user
            stored = db.users.find_one({"email": email})
            assert stored["password_hash"] != password
            assert check_password_hash(stored["password_hash"], password)
            expect_status(register(**{**credentials, "email": email.upper()}), 409)
            expect_status(login(email, "WrongPassword-42"), 401)
            expect_status(login(email, password + chr(0xd800)), 401)

            token = expect_status(login(email, password), 200)["token"]
            headers = {"Authorization": f"Bearer {token}"}
            assert db.auth_sessions.find_one({"_id": token_digest(token)}) is not None
            assert expect_status(client.get("/api/auth/me", headers=headers), 200)["user"] == user
            expect_status(client.post("/api/auth/logout", headers=headers), 204)
            expect_status(client.get("/api/auth/me", headers=headers), 401)

            expired_token = expect_status(login(email, password), 200)["token"]
            result = db.auth_sessions.update_one(
                {"_id": token_digest(expired_token)},
                {"$set": {"expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)}},
            )
            assert result.modified_count == 1
            expect_status(client.get("/api/auth/me", headers={
                "Authorization": f"Bearer {expired_token}",
            }), 401)
    finally:
        db.client.drop_database(db.name)
        db.client.close()

    print("Auth smoke test passed for both divisions.")


if __name__ == "__main__":
    run()
