import os
from io import BytesIO
from uuid import uuid4
from PIL import Image
from bson import ObjectId
from gridfs import GridFSBucket
from app import create_app

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
    assert response.status_code == status, (route, response.status_code, response.get_data(as_text=True)[:500])
    return response

def account(email, division):
    credentials = {"email": email, "password": "safe-test-password"}
    call("POST", "/auth/register", status=201, json={**credentials, "division_id": division})
    return call("POST", "/auth/login", json=credentials).json["token"]

image = BytesIO()
Image.new("RGB", (12, 12), "white").save(image, "PNG")
original = image.getvalue()

def upload(user, data='{}', name="sample.png", contents=original, status=201):
    return call("POST", "/documents/upload", user, status,
                data={"file": (BytesIO(contents), name), "metadata": data}).json

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
    call("POST", "/metadata-fields", owner, 201, json={"key": "category", "label": "Category", "type": "text"})
    upload(owner, '{"Division":"Division B"}', status=403)
    upload(owner, '{"report_type":"unknown"}', status=400)
    doc_id = upload(owner, '{"Report Type":"Financial","category":"Quarterly"}')["doc_id"]
    assert GridFSBucket(db).open_download_stream(ObjectId(doc_id)).read() == original
    call("PATCH", "/metadata-fields/report_type", owner, json={
        "label": "Report Category", "options": [{"id": "financial", "label": "Finance"}],
    })
    from metadata_fields import definitions, display_values
    with app.app_context():
        assert display_values(db.documents.find_one({"_id": ObjectId(doc_id)}), definitions())["Report Category"] == "Finance"
        assert display_values({"metadata": {"Report Type": "Financial", "Old Field": "Kept"}}, definitions()) == {
            "Report Category": "Finance", "Old Field": "Kept"}
    print("Metadata and upload checks passed.")
    assert call("GET", "/documents?Report%20Type=Financial", owner).json["documents"][0]["doc_id"] == doc_id
    assert not call("GET", "/documents?Division=Division%20A", other).json["documents"]
    restricted = call("GET", "/documents/" + doc_id, other).json["document"]
    assert set(restricted) == {"doc_id", "division", "can_download", "request_status"} and not restricted["can_download"]
    call("GET", "/documents/" + doc_id + "/download", other, 404)
    assert call("GET", "/documents/" + doc_id + "/download", owner).data == original
    print("Document hub, scoped details, and streaming download passed.")
    outsider = account("outsider@example.test", "division-b")
    created = call("POST", "/access/request", other, 201, json={"doc_id": doc_id}).json["access_request"]
    request_id = created["request_id"]
    assert call("POST", "/access/request", other, json={"doc_id": doc_id}).json["access_request"] == created
    assert call("GET", "/access/requests", owner).json["requests"][0]["request_id"] == request_id
    call("POST", "/access/approve", outsider, 404, json={"request_id": request_id})
    call("GET", "/documents/" + doc_id + "/download", other, 404)
    call("POST", "/access/approve", owner, json={"request_id": request_id})
    call("POST", "/access/reject", owner, 409, json={"request_id": request_id})
    assert call("GET", "/documents/" + doc_id + "/download", other).data == original
    call("GET", "/documents/" + doc_id + "/download", outsider, 404)
    rejected_doc = upload(owner, name="rejected.png")["doc_id"]
    denied = call("POST", "/access/request", other, 201, json={"doc_id": rejected_doc}).json["access_request"]
    call("POST", "/access/reject", owner, json={"request_id": denied["request_id"]})
    assert call("GET", "/documents/" + rejected_doc, other).json["document"]["request_status"] == "rejected"
    assert len(call("GET", "/access/requests?direction=outgoing", other).json["requests"]) == 2
    assert not call("GET", "/access/requests?direction=outgoing", outsider).json["requests"]
    print("Access request isolation, approval, rejection, and single-decision checks passed.")
    from datetime import datetime, timedelta, timezone
    from PIL import ImageDraw, ImageFont
    from ocr_worker import backfill, claim, finish, process
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    bitmap = Image.new("RGB", (850, 500), "white")
    draw = ImageDraw.Draw(bitmap)
    draw.text((55, 160), "ORCHARD SIGNAL", fill="black", font=ImageFont.load_default(size=64))
    image_file = BytesIO()
    bitmap.save(image_file, format="PNG")
    scanned = BytesIO()
    bitmap.save(scanned, format="PDF")

    writer = PdfWriter()
    page = writer.add_blank_page(612, 792)
    name = NameObject
    page[name("/Resources")] = DictionaryObject({name("/Font"): DictionaryObject({
        name("/F1"): DictionaryObject({
            name("/Type"): name("/Font"), name("/Subtype"): name("/Type1"),
            name("/BaseFont"): name("/Helvetica"),
        }),
    })})
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 28 Tf 50 500 Td (EMBEDDED LANTERN) Tj ET")
    page[name("/Contents")] = writer._add_object(stream)
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
    db.documents.update_one({"_id": abandoned["_id"]}, {"$set": {
        "ocr_lease_until": datetime.now(timezone.utc) - timedelta(seconds=1),
    }})
    reclaimed = claim(db)
    assert reclaimed["_id"] == abandoned["_id"] and reclaimed["ocr_lease"] != abandoned["ocr_lease"]
    finish(db, abandoned, {"ocr_status": "failed"})
    assert db.documents.find_one({"_id": reclaimed["_id"]})["ocr_lease"] == reclaimed["ocr_lease"]
    process(db, reclaimed)
    while row := claim(db):
        process(db, row)
    for filename, expected in [("bitmap.png", "ORCHARD SIGNAL"), ("scanned.pdf", "ORCHARD SIGNAL"),
                               ("text.pdf", "EMBEDDED LANTERN")]:
        row = db.documents.find_one({"_id": ObjectId(identifiers[filename])})
        assert row["ocr_status"] == "ready" and expected in row["ocr_text"], (filename, row)
    assert call("GET", "/documents/" + failed_id, owner).json["document"]["ocr_status"] == "failed"
    assert call("GET", "/documents/" + failed_id + "/download", owner).data == many_pdf.getvalue()
    print("OCR checks passed for images, scanned and text PDFs, stale leases, backfill, and failed jobs.")
    assert {doc["doc_id"] for doc in call("GET", "/search?q=ORCHARD%20SIGNAL", owner).json["documents"]} == {
        identifiers["bitmap.png"], identifiers["scanned.pdf"],
    }
    for q, expected_id in [("rejected", rejected_doc), ("Finance", doc_id),
                           ("Quarterly", doc_id), ("EMBEDDED%20LANTERN", identifiers["text.pdf"])]:
        assert expected_id in {doc["doc_id"] for doc in call("GET", "/search?q=" + q, owner).json["documents"]}
        assert not call("GET", "/search?q=" + q, other).json["documents"]
    assert not call("GET", "/search?q=.%2A", owner).json["documents"]
    call("GET", "/search?q=", owner, 400)
    call("GET", "/search?q=finance", status=401)
    print("PASS: search by title, configured metadata, and OCR with division isolation.")
    print("PASS: all eight assignment API routes and supporting flows passed.")
except Exception as error:
    print(f"FAIL: {error!r}", flush=True)
    raise
finally:
    db.client.drop_database(db.name)
    db.client.close()
