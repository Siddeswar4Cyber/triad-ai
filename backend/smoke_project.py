import os
from datetime import datetime, timedelta, timezone
from io import BytesIO
from uuid import uuid4

from app import create_app
from bson import ObjectId
from gridfs import GridFSBucket
from metadata_fields import definitions, display_values
from ocr_worker import backfill, claim, finish, process
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

os.environ["MONGODB_DATABASE"] = "triad_check_" + uuid4().hex
app = create_app()
db = app.extensions["triad_db"]
client = app.test_client()


def command(*args):
    result = app.test_cli_runner().invoke(args=list(args))
    assert result.exit_code == 0, (result.output, result.exception)


def call(method, route, user=None, status=200, **kwargs):
    headers = {"Authorization": "Bearer " + user} if user else {}
    response = client.open("/api" + route, method=method, headers=headers, **kwargs)
    assert response.status_code == status, (
        route,
        response.status_code,
        response.get_data(as_text=True)[:500],
    )
    return response


def account(email, division):
    credentials = {"email": email, "password": "safe-test-password"}
    call("POST", "/auth/register", status=201, json={**credentials, "division_id": division})
    return call("POST", "/auth/login", json=credentials).json["token"]


image = BytesIO()
Image.new("RGB", (12, 12), "white").save(image, "PNG")
original = image.getvalue()


def upload(user, data="{}", name="sample.png", contents=original, status=201):
    return call(
        "POST", "/documents/upload", user, status, data={"file": (BytesIO(contents), name), "metadata": data}
    ).json


try:
    call("GET", "/health")
    call("POST", "/documents/upload", status=401)
    command("init-auth")
    command("init-metadata")
    command("init-access")
    owner = account("owner@example.test", "division-a")
    other = account("other@example.test", "division-b")
    command("promote-admin", "owner@example.test")
    call("POST", "/metadata-fields", other, 403, json={})
    call(
        "POST", "/metadata-fields", owner, 201, json={"key": "category", "label": "Category", "type": "text"}
    )
    upload(owner, '{"Division":"Division B"}', status=403)
    upload(owner, '{"report_type":"unknown"}', status=400)
    doc_id = upload(owner, '{"Report Type":"Financial","category":"Quarterly"}')["doc_id"]
    assert GridFSBucket(db).open_download_stream(ObjectId(doc_id)).read() == original
    call(
        "PATCH",
        "/metadata-fields/report_type",
        owner,
        json={
            "label": "Report Category",
            "options": [{"id": "financial", "label": "Finance"}],
        },
    )
    with app.app_context():
        assert (
            display_values(db.documents.find_one({"_id": ObjectId(doc_id)}), definitions())["Report Category"]
            == "Finance"
        )
        assert display_values(
            {"metadata": {"Report Type": "Financial", "Old Field": "Kept"}}, definitions()
        ) == {"Report Category": "Finance", "Old Field": "Kept"}
    print("Metadata and upload checks passed.")
    assert call("GET", "/documents?Report%20Type=Financial", owner).json["documents"][0]["doc_id"] == doc_id
    assert not call("GET", "/documents?Division=Division%20A", other).json["documents"]
    restricted = call("GET", "/documents/" + doc_id, other).json["document"]
    assert (
        set(restricted) == {"doc_id", "division", "can_download", "request_status"}
        and not restricted["can_download"]
    )
    call("GET", "/documents/" + doc_id + "/download", other, 404)
    assert call("GET", "/documents/" + doc_id + "/download", owner).data == original
    print("Document hub, scoped details, and streaming download passed.")
    outsider = account("outsider@example.test", "division-b")
    created = call("POST", "/access/request", other, 201, json={"doc_id": doc_id}).json["access_request"]
    request_id = created["request_id"]
    assert call("POST", "/access/request", other, json={"doc_id": doc_id}).json["access_request"] == created
    incoming = call("GET", "/access/requests?status=pending", owner).json["requests"]
    assert [entry["request_id"] for entry in incoming] == [request_id]
    sent = call("GET", "/access/requests?direction=outgoing&status=pending", other).json["requests"]
    assert len(sent) == 1 and "title" not in sent[0]
    assert not call("GET", "/access/requests?status=pending", other).json["requests"]
    call("GET", "/access/requests?status=unknown", owner, 400)
    call("POST", "/access/approve", outsider, 404, json={"request_id": request_id})
    call("GET", "/documents/" + doc_id + "/download", other, 404)
    call("POST", "/access/approve", owner, json={"request_id": request_id})
    call("POST", "/access/reject", owner, 409, json={"request_id": request_id})
    assert call("GET", "/documents/" + doc_id + "/download", other).data == original
    approved = call("GET", "/access/requests?direction=outgoing&status=approved", other).json["requests"]
    assert len(approved) == 1 and approved[0]["title"] == "sample"
    assert not call("GET", "/access/requests?direction=outgoing&status=pending", other).json["requests"]
    call("GET", "/documents/" + doc_id + "/download", outsider, 404)
    rejected_doc = upload(owner, name="rejected.png")["doc_id"]
    denied = call("POST", "/access/request", other, 201, json={"doc_id": rejected_doc}).json["access_request"]
    call("POST", "/access/reject", owner, json={"request_id": denied["request_id"]})
    assert call("GET", "/documents/" + rejected_doc, other).json["document"]["request_status"] == "rejected"
    assert len(call("GET", "/access/requests?direction=outgoing", other).json["requests"]) == 2
    assert not call("GET", "/access/requests?direction=outgoing", outsider).json["requests"]
    print("Access request isolation, approval, rejection, and single-decision checks passed.")

    bitmap = Image.new("RGB", (850, 500), "white")
    draw = ImageDraw.Draw(bitmap)
    draw.text((55, 160), "ORCHARD SIGNAL", fill="black", font=ImageFont.load_default(size=64))
    image_file = BytesIO()
    bitmap.save(image_file, format="PNG")
    scanned = BytesIO()
    bitmap.save(scanned, format="PDF")

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
                    ),
                }
            )
        }
    )
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 28 Tf 50 500 Td (EMBEDDED LANTERN) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(stream)
    text_pdf = BytesIO()
    writer.write(text_pdf)

    identifiers = {}
    for filename, fixture in [("bitmap.png", image_file), ("scanned.pdf", scanned), ("text.pdf", text_pdf)]:
        identifiers[filename] = upload(owner, name=filename, contents=fixture.getvalue())["doc_id"]
    many = PdfWriter()
    for _ in range(51):
        many.add_blank_page(72, 72)
    many_pdf = BytesIO()
    many.write(many_pdf)
    failed_id = upload(owner, name="large-page-count.pdf", contents=many_pdf.getvalue())["doc_id"]

    db.documents.update_one({"_id": ObjectId(doc_id)}, {"$unset": {"ocr_status": ""}})
    assert backfill(db) == 1 and backfill(db) == 0
    abandoned = claim(db)
    db.documents.update_one(
        {"_id": abandoned["_id"]},
        {
            "$set": {
                "ocr_lease_until": datetime.now(timezone.utc) - timedelta(seconds=1),
            }
        },
    )
    reclaimed = claim(db)
    assert reclaimed["_id"] == abandoned["_id"] and reclaimed["ocr_lease"] != abandoned["ocr_lease"]
    finish(db, abandoned, {"ocr_status": "failed"})
    assert db.documents.find_one({"_id": reclaimed["_id"]})["ocr_lease"] == reclaimed["ocr_lease"]
    process(db, reclaimed)
    while row := claim(db):
        process(db, row)
    for filename, expected in [
        ("bitmap.png", "ORCHARD SIGNAL"),
        ("scanned.pdf", "ORCHARD SIGNAL"),
        ("text.pdf", "EMBEDDED LANTERN"),
    ]:
        row = db.documents.find_one({"_id": ObjectId(identifiers[filename])})
        assert row["ocr_status"] == "ready" and expected in row["ocr_text"], (filename, row)
    assert call("GET", "/documents/" + failed_id, owner).json["document"]["ocr_status"] == "failed"
    assert call("GET", "/documents/" + failed_id + "/download", owner).data == many_pdf.getvalue()
    print("OCR checks passed for images, scanned and text PDFs, stale leases, backfill, and failed jobs.")
    assert {doc["doc_id"] for doc in call("GET", "/search?q=ORCHARD%20SIGNAL", owner).json["documents"]} == {
        identifiers["bitmap.png"],
        identifiers["scanned.pdf"],
    }
    for q, expected_id in [
        ("rejected", rejected_doc),
        ("Finance", doc_id),
        ("Quarterly", doc_id),
        ("EMBEDDED%20LANTERN", identifiers["text.pdf"]),
    ]:
        assert expected_id in {
            doc["doc_id"] for doc in call("GET", "/search?q=" + q, owner).json["documents"]
        }
        expected_other = {doc_id} if expected_id == doc_id else set()
        assert {
            doc["doc_id"] for doc in call("GET", "/search?q=" + q, other).json["documents"]
        } == expected_other
    assert not call("GET", "/search?q=.%2A", owner).json["documents"]
    assert call("GET", "/search?q=rejected&scope=title", owner).json["documents"]
    assert not call("GET", "/search?q=rejected&scope=text", owner).json["documents"]
    assert call("GET", "/search?q=Finance&scope=metadata", owner).json["documents"]
    assert not call("GET", "/search?q=Finance&scope=title", owner).json["documents"]
    assert call("GET", "/search?q=ORCHARD%20SIGNAL&scope=text", owner).json["documents"]
    assert not call("GET", "/search?q=ORCHARD%20SIGNAL&scope=title", owner).json["documents"]
    assert not call("GET", "/search?q=ORCHARD%20SIGNAL&scope=text", other).json["documents"]
    call("GET", "/search?q=Finance&scope=invalid", owner, 400)
    call("GET", "/search?q=", owner, 400)
    call("GET", "/search?q=finance", status=401)
    for filename, query in [("text.pdf", "EMBEDDED%20LANTERN"), ("scanned.pdf", "ORCHARD%20SIGNAL")]:
        target = identifiers[filename]
        pending = call("POST", "/access/request", other, 201, json={"doc_id": target}).json["access_request"]
        assert not call("GET", "/search?q=" + query + "&scope=text", other).json["documents"]
        call("POST", "/access/approve", owner, json={"request_id": pending["request_id"]})
        assert target in {
            doc["doc_id"]
            for doc in call("GET", "/search?q=" + query + "&scope=text", other).json["documents"]
        }
        assert not call("GET", "/search?q=" + query + "&scope=text", outsider).json["documents"]
    print("PASS: search by title, configured metadata, and OCR with division isolation.")
    # Exercise a new division using existing auth and global-admin APIs.
    for route in ("/admin/divisions", "/admin/documents", "/admin/requests"):
        call("GET", route, other, 403)
    call("POST", "/admin/divisions", other, 403, json={"name": "Forbidden"})
    defaults = call("GET", "/admin/divisions", owner).json["divisions"]
    assert {row["id"]: row["name"] for row in defaults} == {
        "division-a": "Division A",
        "division-b": "Division B",
    }

    division = call("POST", "/admin/divisions", owner, 201, json={"name": "Division C"}).json["division"]
    new_id = division["id"]
    call("POST", "/admin/divisions", owner, 409, json={"name": "division c"})
    assert division in call("GET", "/auth/divisions").json["divisions"]
    division_c = account("division-c@example.test", new_id)
    call("PATCH", "/admin/divisions/" + new_id, division_c, 403, json={"active": False})
    new_doc = upload(division_c, '{"report_type":"financial"}', name="division-c-only.png")["doc_id"]
    approval = call("POST", "/access/request", other, 201, json={"doc_id": new_doc}).json["access_request"]
    approval_id = approval["request_id"]
    assert not call("GET", "/documents?Division=" + new_id, other).json["documents"]
    assert not call("GET", "/search?q=division-c-only", other).json["documents"]
    call("POST", "/access/approve", outsider, 404, json={"request_id": approval_id})
    call("POST", "/access/reject", outsider, 404, json={"request_id": approval_id})

    documents = call("GET", "/admin/documents?division_id=" + new_id, owner).json["documents"]
    assert [item["doc_id"] for item in documents] == [new_doc]
    params = "q=division-c-only&scope=title"
    assert [
        item["doc_id"] for item in call("GET", "/admin/documents?" + params, owner).json["documents"]
    ] == [new_doc]
    assert not call("GET", "/admin/documents?" + params + "&division_id=division-a", owner).json["documents"]
    assert [
        item["doc_id"]
        for item in call(
            "GET", "/admin/documents?q=Finance&scope=metadata&division_id=" + new_id, owner
        ).json["documents"]
    ] == [new_doc]
    assert {
        item["doc_id"]
        for item in call("GET", "/admin/documents?q=ORCHARD%20SIGNAL&scope=text", owner).json["documents"]
    } == {identifiers["bitmap.png"], identifiers["scanned.pdf"]}
    call("GET", "/admin/documents?" + params, other, 403)
    call("GET", "/admin/documents?q=test&scope=invalid", owner, 400)
    assert (
        len({item["owner_division_id"] for item in call("GET", "/admin/documents", owner).json["documents"]})
        == 2
    )
    pending = call("GET", "/admin/requests?status=pending&division_id=" + new_id, owner).json["requests"]
    assert [entry["request_id"] for entry in pending] == [approval_id]
    details = call("GET", "/documents/" + new_doc, owner).json["document"]
    assert details["title"] == "division-c-only" and details["can_download"]
    download_path = "/documents/" + new_doc + "/download"
    download = call("GET", download_path, owner)
    assert download.data == original and download.headers["Content-Disposition"].startswith("attachment")
    call("GET", download_path, other, 404)
    preview_path = "/documents/" + new_doc + "/preview"
    preview = call("GET", preview_path, owner)
    assert preview.data == original and preview.mimetype == "image/png"
    assert preview.headers["Content-Disposition"].startswith("inline")
    assert preview.headers["Cache-Control"] == "private, no-store"
    call("GET", preview_path, status=401)
    call("GET", preview_path, other, 404)
    assert call("GET", preview_path, division_c).data == original
    call("GET", "/documents/000000000000000000000000/preview", owner, 404)

    renamed = call("PATCH", "/admin/divisions/" + new_id, owner, json={"name": "Research"}).json["division"]
    assert renamed["id"] == new_id
    assert call("GET", "/auth/me", division_c).json["user"]["division"] == "Research"
    assert call("GET", "/documents?Division=Research", division_c).json["documents"][0]["doc_id"] == new_doc
    call("PATCH", "/admin/divisions/" + new_id, owner, json={"active": False})
    command("init-auth")
    assert all(row["id"] != new_id for row in call("GET", "/auth/divisions").json["divisions"])
    call(
        "POST",
        "/auth/register",
        status=400,
        json={
            "email": "inactive@example.test",
            "password": "safe-test-password",
            "division_id": new_id,
        },
    )
    upload(division_c, status=403)
    assert call("GET", "/documents/" + new_doc + "/download", division_c).data == original
    assert (
        call("GET", "/admin/requests?division_id=" + new_id, owner).json["requests"][0]["division"]
        == "Research"
    )
    call("POST", "/access/approve", owner, json={"request_id": approval_id})
    assert call("GET", "/documents/" + new_doc + "/download", other).data == original
    assert [
        doc["doc_id"] for doc in call("GET", "/search?q=division-c-only&scope=title", other).json["documents"]
    ] == [new_doc]
    assert not call("GET", "/search?q=division-c-only", outsider).json["documents"]
    call("GET", "/documents/" + new_doc + "/download", outsider, 404)
    assert call("GET", download_path, owner).data == original
    assert call("GET", preview_path, owner).data == original
    assert call("GET", preview_path, other).data == original
    call("GET", preview_path, outsider, 404)

    metadata_path = "/documents/" + new_doc + "/metadata"
    assert call("GET", metadata_path, owner).json["values"]["report_type"] == "financial"
    call("GET", metadata_path, division_c, 403)
    call("PATCH", metadata_path, division_c, 403, json={"metadata": {"report_type": "operational"}})
    call("PATCH", metadata_path, owner, 400, json={"metadata": {"owner_division_id": "division-a"}})
    call("PATCH", metadata_path, owner, 400, json={"metadata": {"report_type": "invalid"}})
    call("PATCH", metadata_path, owner, 204, json={"metadata": {"report_type": "operational"}})
    assert call("GET", metadata_path, owner).json["values"]["report_type"] == "operational"
    assert [
        item["doc_id"]
        for item in call(
            "GET", "/admin/documents?q=Operational&scope=metadata&division_id=" + new_id, owner
        ).json["documents"]
    ] == [new_doc]
    call("PATCH", metadata_path, owner, 204, json={"metadata": {"report_type": ""}})
    assert "report_type" not in call("GET", metadata_path, owner).json["values"]

    # A regular owner can still decide locally, and a global admin can reject.
    call("PATCH", "/admin/divisions/" + new_id, owner, json={"active": True})
    pdf_id = upload(division_c, name="preview.pdf", contents=text_pdf.getvalue())["doc_id"]
    pdf_preview = call("GET", "/documents/" + pdf_id + "/preview", owner)
    assert pdf_preview.mimetype == "image/png" and pdf_preview.headers["X-Preview-Has-Next"] == "false"
    with Image.open(BytesIO(pdf_preview.data)) as decoded:
        assert decoded.convert("L").getextrema()[0] < 255
    assert call("GET", "/documents/" + pdf_id + "/download", owner).data == text_pdf.getvalue()
    call("GET", "/documents/" + pdf_id + "/preview?frame=1", owner, 404)
    tiff = BytesIO()
    Image.new("RGB", (12, 12), "red").save(
        tiff, "TIFF", save_all=True, append_images=[Image.new("RGB", (12, 12), "blue")]
    )
    tiff_id = upload(division_c, name="pages.tiff", contents=tiff.getvalue())["doc_id"]
    tiff_path = "/documents/" + tiff_id + "/preview"
    for frame, color in enumerate(((255, 0, 0, 255), (0, 0, 255, 255))):
        page = call("GET", tiff_path + f"?frame={frame}", owner)
        assert page.mimetype == "image/png" and page.headers["X-Preview-Has-Next"] == str(frame == 0).lower()
        with Image.open(BytesIO(page.data)) as decoded:
            assert decoded.getpixel((0, 0)) == color
    call("GET", tiff_path + "?frame=2", owner, 404)
    for label, decider in (("regular", division_c), ("admin", owner)):
        reject_doc = upload(division_c, name="reject-" + label + ".png")["doc_id"]
        reject_id = call("POST", "/access/request", other, 201, json={"doc_id": reject_doc}).json[
            "access_request"
        ]["request_id"]
        call("POST", "/access/reject", decider, json={"request_id": reject_id})
        call("GET", "/documents/" + reject_doc + "/download", other, 404)
    print(
        "Global admin, division lifecycle, document previews, cross-division decisions, and per-user downloads passed."
    )
    option_route = "/metadata-fields/report_type/options"
    call("POST", option_route, status=401, json={"label": "Annual"})
    annual = call("POST", option_route, other, 201, json={"label": "Annual"}).json["option"]
    assert call("POST", option_route, other, json={"label": " annual "}).json["option"]["id"] == annual["id"]
    call("POST", option_route, other, 400, json={"label": ""})
    custom_doc = upload(division_c, '{"report_type":"' + annual["id"] + '"}', name="annual.png")["doc_id"]
    assert (
        call("GET", "/documents/" + custom_doc, division_c).json["document"]["metadata"]["Report Category"]
        == "Annual"
    )
    assert custom_doc in {
        item["doc_id"]
        for item in call("GET", "/search?q=Annual&scope=metadata", division_c).json["documents"]
    }
    print("PASS: users can add and reuse report types, upload them, and search by their labels.")
    call("GET", "/admin/activity", other, 403)
    call("GET", "/admin/activity", status=401)
    call("GET", "/admin/activity?page=0", owner, 400)
    for action in (
        "account_registered",
        "document_uploaded",
        "access_approved",
        "access_rejected",
        "document_metadata_updated",
        "division_created",
        "report_type_added",
        "admin_promoted",
    ):
        events = call("GET", "/admin/activity?action=" + action, owner).json["entries"]
        assert events and all(row["action"] == action for row in events), action
        assert all(row["actor"]["email"] and row["created_at"] for row in events)
        assert "password" not in str(events) and "token" not in str(events)
    accounts = call("GET", "/admin/activity?action=account_registered", owner).json["entries"]
    assert any(row["actor"]["email"] == "other@example.test" for row in accounts)
    decisions = call("GET", "/admin/activity?action=access_approved", owner).json["entries"]
    assert any(row["details"]["requester"] == "other@example.test" for row in decisions)
    requests_log = call("GET", "/admin/activity?category=requests", owner).json["entries"]
    assert requests_log and all(
        row["action"] in ("access_requested", "access_approved", "access_rejected") for row in requests_log
    )
    assert not call("GET", "/admin/activity?category=accounts&action=document_uploaded", owner).json[
        "entries"
    ]
    stats = call("GET", "/admin/activity?category=requests", owner).json["statistics"]
    assert stats == {
        "accounts": db.activity_log.count_documents({"action": "account_registered"}),
        "uploads": db.activity_log.count_documents({"action": "document_uploaded"}),
        "approvals": db.activity_log.count_documents({"action": "access_approved"}),
    }
    assert all(value > 0 for value in stats.values())
    call("GET", "/admin/activity?category=invalid", owner, 400)
    print(
        "PASS: admin activity contains registrations, uploads, decisions, and changes with protected access."
    )
    print("PASS: all eight assignment API routes and supporting flows passed.")
except Exception as error:
    print(f"FAIL: {error!r}", flush=True)
    raise
finally:
    db.client.drop_database(db.name)
    db.client.close()
