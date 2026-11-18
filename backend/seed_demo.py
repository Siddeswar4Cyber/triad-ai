"""Reset an explicitly named local database and seed connected demonstration records.

Stop the backend and OCR worker and take a backup before running --reset.
Use --verify-only to check the seeded dataset without changing it.
"""

import argparse
import json
import os
from io import BytesIO

from activity_log import ACTIVITY_CATEGORIES
from app import create_app
from gridfs import GridFSBucket
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

PASSWORD = os.getenv("DEMO_PASSWORD", "TriadDemo2026!")
DIVISIONS = [
    ("Division A", "Finance", ("Maya Rao", "Arun Mehta", "Nisha Shah")),
    ("Division B", "Sales", ("Daniel Brooks", "Sofia Martinez", "Liam Chen")),
    ("Operations", "Operations", ("Aisha Khan", "Noah Williams", "Priya Nair")),
    ("People and Culture", "People", ("Emma Wilson", "Ravi Patel", "Zoe Anderson")),
    ("Research and Development", "Research", ("Oliver Smith", "Ananya Iyer", "Ethan Davis")),
]
REPORT_TYPES = ["Financial", "Operational", "Audit", "Compliance", "Research"]
REPORTS = [
    (
        "Quarterly Budget Review",
        [
            "Budget allocated: 480000 USD",
            "Actual expenditure: 452600 USD",
            "Variance: 27400 USD under budget",
            "Action: reconcile vendor invoices",
        ],
    ),
    (
        "Service Delivery Update",
        [
            "Requests completed: 1248",
            "Service level achieved: 98.4 percent",
            "Open escalations: 7",
            "Action: review capacity before month end",
        ],
    ),
    (
        "Internal Controls Assessment",
        [
            "Controls reviewed: 42",
            "Controls effective: 39",
            "Remediation actions: 3",
            "Action: verify evidence retention",
        ],
    ),
    (
        "Policy Compliance Review",
        [
            "Policies reviewed: 18",
            "Training completion: 96 percent",
            "Exceptions awaiting review: 2",
            "Action: close outstanding attestations",
        ],
    ),
    (
        "Process Improvement Study",
        [
            "Pilot duration: 6 weeks",
            "Participants: 24",
            "Processing time reduced: 18 percent",
            "Action: validate results next quarter",
        ],
    ),
]


def email_for(name):
    return name.lower().replace(" ", ".") + "@triad.example.test"


def document_bytes(title, lines, extension):
    """Create readable originals so OCR and previews use real PDF/image content."""
    if extension == "pdf":
        writer = PdfWriter()
        page = writer.add_blank_page(612, 792)
        page[NameObject("/Resources")] = DictionaryObject(
            {
                NameObject("/Font"): DictionaryObject(
                    {
                        NameObject("/F1"): DictionaryObject(
                            {
                                NameObject("/Type"): NameObject("/Font"),
                                NameObject("/Subtype"): NameObject("/Type1"),
                                NameObject("/BaseFont"): NameObject("/Helvetica"),
                            }
                        )
                    }
                )
            }
        )
        commands = ["BT /F1 15 Tf 45 740 Td"]
        for line in [title, "", *lines]:
            escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            commands.extend([f"({escaped}) Tj", "0 -28 Td"])
        commands.append("ET")
        stream = DecodedStreamObject()
        stream.set_data("\n".join(commands).encode("ascii"))
        page[NameObject("/Contents")] = writer._add_object(stream)
        output = BytesIO()
        writer.write(output)
        return output.getvalue()

    image = Image.new("RGB", (1400, 1000), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=30)
    draw.multiline_text((55, 60), "\n\n".join([title, *lines]), fill="#152c23", font=font, spacing=12)
    output = BytesIO()
    image.save(output, format={"png": "PNG", "jpg": "JPEG", "tiff": "TIFF", "webp": "WEBP"}[extension])
    return output.getvalue()


def verify(db, require_ocr=False):
    counts = {name: db[name].count_documents({}) for name in db.list_collection_names()}
    for name in (
        "users",
        "divisions",
        "metadata_fields",
        "documents",
        "access_requests",
        "activity_log",
        "auth_sessions",
        "fs.files",
        "fs.chunks",
    ):
        assert counts.get(name, 0) >= 5, (name, counts.get(name, 0))
    for status in ("pending", "approved", "rejected"):
        assert db.access_requests.count_documents({"status": status}) >= 5
    for role in ("admin", "user"):
        assert db.users.count_documents({"role": role}) >= 5
    for content_type in ("application/pdf", "image/png", "image/jpeg", "image/tiff", "image/webp"):
        assert db.documents.count_documents({"content_type": content_type}) >= 5
    for actions in ACTIVITY_CATEGORIES.values():
        assert db.activity_log.count_documents({"action": {"$in": actions}}) >= 5
    fields = list(db.metadata_fields.find())
    for field in fields:
        if field["type"] == "select":
            assert len(field["options"]) >= 5
    for user in db.users.find():
        assert db.divisions.find_one({"_id": user["division_id"]})
    bucket = GridFSBucket(db)
    for doc in db.documents.find():
        assert db.documents.count_documents({"owner_division_id": doc["owner_division_id"]}) >= 5
        assert db.users.find_one({"_id": doc["uploaded_by"], "division_id": doc["owner_division_id"]})
        with bucket.open_download_stream(doc["gridfs_file_id"]) as original:
            assert len(original.read()) == doc["size"]
        for field in fields:
            value = doc.get("metadata_fields", {}).get(field["_id"])
            if field["type"] == "select" and value is not None:
                assert value in {option["id"] for option in field["options"]}
        if require_ocr:
            assert doc["ocr_status"] == "ready" and doc.get("ocr_text"), doc["filename"]
    for entry in db.access_requests.find():
        doc = db.documents.find_one({"_id": entry["document_id"]})
        requester = db.users.find_one({"_id": entry["requester_id"]})
        assert doc and requester and doc["owner_division_id"] == entry["owner_division_id"]
        assert requester["division_id"] != doc["owner_division_id"]
        if entry["status"] != "pending":
            decider = db.users.find_one({"_id": entry["decided_by"]})
            assert decider and (
                decider["role"] == "admin" or decider["division_id"] == doc["owner_division_id"]
            )
    assert counts["fs.files"] == counts["documents"]
    assert not db["fs.chunks"].count_documents({"files_id": {"$nin": db["fs.files"].distinct("_id")}})
    print(json.dumps({"counts": counts, "ocr_ready": db.documents.count_documents({"ocr_status": "ready"})}))


def seed(app):
    db = app.extensions["triad_db"]
    client = app.test_client()

    def call(method, route, token=None, status=200, **kwargs):
        headers = {"Authorization": "Bearer " + token} if token else {}
        response = client.open("/api" + route, method=method, headers=headers, **kwargs)
        if response.status_code != status:
            raise RuntimeError(f"{method} {route}: {response.status_code} {response.get_json(silent=True)}")
        result = response.get_json(silent=True)
        if response.is_streamed:
            response.get_data()
        response.close()
        return result

    def command(*args):
        result = app.test_cli_runner().invoke(args=list(args))
        if result.exit_code:
            raise RuntimeError(result.output)

    # Delete records, preserving collection definitions and existing indexes.
    for collection in db.list_collection_names():
        if collection.startswith("system."):
            continue
        db[collection].delete_many({})
    assert all(
        db[name].count_documents({}) == 0
        for name in db.list_collection_names()
        if not name.startswith("system.")
    )
    for name in ("init-auth", "init-metadata", "init-access"):
        command(name)

    groups = []
    first_admin = None
    for index, (name, department, people) in enumerate(DIVISIONS):
        if index < 2:
            division_id = ("division-a", "division-b")[index]
        else:
            division_id = call("POST", "/admin/divisions", first_admin, 201, json={"name": name})["division"][
                "id"
            ]
        users = []
        for position, person in enumerate(people):
            email = email_for(person)
            credentials = {"email": email, "password": PASSWORD}
            call("POST", "/auth/register", status=201, json={**credentials, "division_id": division_id})
            if position == 0:
                command("promote-admin", email)
            token = call("POST", "/auth/login", json=credentials)["token"]
            users.append({"name": person, "email": email, "token": token})
        if first_admin is None:
            first_admin = users[0]["token"]
        groups.append({"id": division_id, "department": department, "users": users, "documents": []})

    call(
        "PATCH",
        "/metadata-fields/report_type",
        first_admin,
        json={
            "options": [{"label": label} for label in REPORT_TYPES[2:]],
        },
    )
    select_fields = {
        "confidentiality": (
            "Confidentiality",
            ["Public", "Internal", "Confidential", "Restricted", "Highly Confidential"],
        ),
        "reporting_period": (
            "Reporting Period",
            ["FY2026 Q1", "FY2026 Q2", "FY2026 Q3", "FY2026 Q4", "FY2026 Annual"],
        ),
    }
    for key, (label, options) in select_fields.items():
        call(
            "POST",
            "/metadata-fields",
            first_admin,
            201,
            json={
                "key": key,
                "label": label,
                "type": "select",
                "options": [{"label": value} for value in options],
            },
        )
    for key, label in (("prepared_by", "Prepared By"), ("project_code", "Project Code")):
        call("POST", "/metadata-fields", first_admin, 201, json={"key": key, "label": label, "type": "text"})
    definitions = call("GET", "/metadata-fields", first_admin)["fields"]
    choices = {
        field["key"]: {option["label"]: option["id"] for option in field["options"]}
        for field in definitions
        if field["type"] == "select"
    }

    for division_index, group in enumerate(groups):
        for report_index, (report, content) in enumerate(REPORTS):
            title = group["department"] + " - " + report
            owner = group["users"][1]
            period = select_fields["reporting_period"][1][report_index]
            lines = [
                "TRIAD AI Demonstration Dataset",
                "Reporting period: " + period,
                "Prepared by: " + owner["name"],
                *content,
                "Project reference: TRD-" + str(division_index + 1) + str(report_index + 1) + "026",
            ]
            extension = ("pdf", "png", "jpg", "tiff", "webp")[report_index]
            payload = document_bytes(title, lines, extension)
            metadata = {
                "report_type": choices["report_type"][REPORT_TYPES[report_index]],
                "confidentiality": choices["confidentiality"][
                    select_fields["confidentiality"][1][report_index]
                ],
                "reporting_period": choices["reporting_period"][
                    select_fields["reporting_period"][1][report_index]
                ],
                "prepared_by": owner["name"],
                "project_code": f"TRD-{division_index + 1}{report_index + 1}026"
                + ("-DRAFT" if report_index == 0 else ""),
            }
            result = call(
                "POST",
                "/documents/upload",
                owner["token"],
                201,
                data={
                    "file": (BytesIO(payload), title.replace(" ", "_") + "." + extension),
                    "metadata": json.dumps(metadata),
                },
            )
            group["documents"].append(result["doc_id"])

    for index, group in enumerate(groups):
        call(
            "PATCH",
            "/documents/" + group["documents"][0] + "/metadata",
            group["users"][0]["token"],
            204,
            json={"metadata": {"project_code": f"TRD-{index + 1}1026"}},
        )
        requester = groups[(index + 1) % len(groups)]["users"][1]["token"]
        for report_index, status in enumerate(("pending", "approved", "rejected")):
            doc_id = group["documents"][report_index]
            entry = call("POST", "/access/request", requester, 201, json={"doc_id": doc_id})["access_request"]
            if status != "pending":
                action = "approve" if status == "approved" else "reject"
                call(
                    "POST",
                    "/access/" + action,
                    group["users"][2]["token"],
                    json={"request_id": entry["request_id"]},
                )
            if status == "approved":
                call("GET", "/documents/" + doc_id + "/download", requester)
            else:
                call("GET", "/documents/" + doc_id + "/download", requester, 404)
        # Keep both login and logout activity represented with real application events.
        call("POST", "/auth/logout", group["users"][0]["token"], 204)

    verify(db)
    print("Demo seed complete. Accounts use @triad.example.test. See README for sign-in details.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, help="Exact local database name to reset or verify")
    parser.add_argument(
        "--reset", action="store_true", help="Clear every record in this database before seeding"
    )
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--require-ocr", action="store_true")
    args = parser.parse_args()
    if args.reset == args.verify_only:
        parser.error("Choose exactly one of --reset or --verify-only.")
    app = create_app()
    db = app.extensions["triad_db"]
    if db.name != args.database or db.name in ("admin", "local", "config"):
        parser.error("The configured database does not match the explicitly named application database.")
    if args.verify_only:
        verify(db, args.require_ocr)
    else:
        seed(app)


if __name__ == "__main__":
    main()
