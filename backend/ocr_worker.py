import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from gridfs import GridFSBucket
from PIL import Image, ImageOps, ImageSequence
from pymongo import MongoClient, ReturnDocument
from pymongo.errors import PyMongoError
from pypdf import PdfReader

MAX_ATTEMPTS = 3
JOB_SECONDS = 110
LEASE_SECONDS = 150
MAX_TEXT = 400_000


def backfill(db):
    result = db.documents.update_many({"ocr_status": {"$exists": False}}, {
        "$set": {"ocr_status": "pending", "ocr_attempts": 0},
    })
    return result.modified_count


def claim(db):
    now = datetime.now(timezone.utc)
    db.documents.update_many(
        {"ocr_status": "processing", "ocr_lease_until": {"$lte": now}, "ocr_attempts": {"$gte": MAX_ATTEMPTS}},
        {"$set": {"ocr_status": "failed", "ocr_error": "OCR ran out of retry attempts."},
         "$unset": {"ocr_lease": "", "ocr_lease_until": ""}},
    )
    return db.documents.find_one_and_update(
        {"ocr_attempts": {"$lt": MAX_ATTEMPTS}, "$or": [
            {"ocr_status": "pending"},
            {"ocr_status": "processing", "ocr_lease_until": {"$lte": now}},
        ]},
        {"$set": {"ocr_status": "processing", "ocr_lease": uuid4().hex,
                  "ocr_lease_until": now + timedelta(seconds=LEASE_SECONDS)},
         "$inc": {"ocr_attempts": 1}},
        sort=[("created_at", 1), ("_id", 1)], return_document=ReturnDocument.AFTER,
    )


def finish(db, row, values):
    db.documents.update_one(
        {"_id": row["_id"], "ocr_status": "processing", "ocr_lease": row["ocr_lease"]},
        {"$set": values, "$unset": {"ocr_lease": "", "ocr_lease_until": ""}},
    )


def ocr_image(path):
    result = subprocess.run(
        ["tesseract", str(path), "stdout", "-l", "eng"], capture_output=True,
        check=True, timeout=20,
    )
    return result.stdout.decode("utf-8", errors="replace").strip()


def extract(source, content_type):
    page_image = source.with_name("page.png")
    remaining = MAX_TEXT
    snippets = []
    if content_type == "application/pdf":
        with PdfReader(source) as pdf:
            if len(pdf.pages) > 50:
                raise ValueError("OCR supports up to 50 PDF pages.")
            for number, page in enumerate(pdf.pages, 1):
                text = (page.extract_text() or "").strip()
                if not text:
                    subprocess.run([
                        "pdftoppm", "-f", str(number), "-l", str(number), "-scale-to", "2000",
                        "-png", "-singlefile", str(source), str(page_image.with_suffix("")),
                    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=15)
                    text = ocr_image(page_image)
                snippets.append(text[:remaining])
                remaining -= len(snippets[-1]) + 1
                if remaining <= 0:
                    break
    else:
        with Image.open(source) as image:
            if getattr(image, "n_frames", 1) > 50:
                raise ValueError("OCR supports up to 50 image frames.")
            for frame in ImageSequence.Iterator(image):
                if frame.width * frame.height > 25_000_000:
                    raise ValueError("Image frame exceeds OCR dimensions.")
                prepared = ImageOps.exif_transpose(frame).convert("RGB")
                prepared.thumbnail((2600, 2600))
                prepared.save(page_image)
                snippets.append(ocr_image(page_image)[:remaining])
                remaining -= len(snippets[-1]) + 1
                if remaining <= 0:
                    break
    return "\n".join(snippets)[:MAX_TEXT]


def process(db, row):
    try:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "original")
            output = source.with_name("text.txt")
            with GridFSBucket(db).open_download_stream(row["gridfs_file_id"]) as stream, source.open("wb") as file:
                shutil.copyfileobj(stream, file, length=256 * 1024)
            with subprocess.Popen(
                [sys.executable, __file__, "extract", str(source), row["content_type"], str(output)],
                start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            ) as child:
                try:
                    code = child.wait(timeout=JOB_SECONDS)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    raise
            if code == 75:
                raise subprocess.TimeoutExpired("OCR page", 20)
            if code != 0:
                finish(db, row, {"ocr_status": "failed", "ocr_error": "This file could not be processed within OCR limits."})
                return
            text = " ".join(output.read_text(encoding="utf-8").split())
    except (subprocess.TimeoutExpired, OSError, PyMongoError) as error:
        exhausted = row["ocr_attempts"] >= MAX_ATTEMPTS
        finish(db, row, {"ocr_status": "failed" if exhausted else "pending",
                         "ocr_error": "OCR timed out or storage was unavailable." if exhausted else None})
        print(f"OCR attempt failed for {row['_id']}: {type(error).__name__}", flush=True)
        return
    finish(db, row, {"ocr_status": "ready", "ocr_text": text, "ocr_error": None})


def run():
    with MongoClient(os.environ["MONGODB_URI"], timeoutMS=3000) as client:
        db = client[os.getenv("MONGODB_DATABASE", "triad_dms")]
        while True:
            try:
                row = claim(db)
                if row is not None:
                    process(db, row)
                else:
                    time.sleep(1)
            except PyMongoError as error:
                print(f"OCR storage unavailable: {type(error).__name__}", flush=True)
                time.sleep(3)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "extract":
        try:
            text = extract(Path(sys.argv[2]), sys.argv[3])
        except subprocess.TimeoutExpired:
            raise SystemExit(75)
        Path(sys.argv[4]).write_text(text, encoding="utf-8")
    else:
        run()
