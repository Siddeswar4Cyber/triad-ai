# TRIAD AI Document Management System

A local document workspace built with HTML, CSS, JavaScript, Flask, MongoDB/GridFS, and a background OCR worker. It supports division-based access, configurable metadata, cross-division requests, and search.

## Start locally

Install Docker Desktop with Linux containers and run these commands from the repository root.

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
docker compose up --build -d
docker compose ps
curl.exe -i http://127.0.0.1:5001/api/health
```

Open [the workspace](http://127.0.0.1:5174/). MongoDB's health check gates service startup. Flask creates authentication and request indexes and seeds Report Type if needed. Keep `MONGODB_URI=mongodb://mongo:27017` for the bundled database. `MONGODB_DATABASE` defaults to `triad_dms`. The Docker stack and self-selected divisions are intended for local demonstration.

## Try the workflow

1. Create one account in Division A and another in Division B. To enable Metadata Settings for the Division A account, run the command below with its email, then sign in again.
2. In **Settings**, add a text or select field, or edit Report Type. Select the active settings in the **Upload** view and upload a file from Division A. Owning division is assigned by the server.
3. In **Documents**, filter by your division or metadata, open the file, and copy its direct link. Choose **Refresh OCR status** until the details view shows Ready. In **Search**, enter a distinctive word from the document.
4. Sign in as the Division B account and open the copied link. Select **Request access**. The requester can check **Requests → Sent**.
5. Sign in as Division A and use **Requests → Incoming** to approve or reject the request. After approval, sign in as the Division B requester and download the file from the direct link or Sent history.

```powershell
docker compose exec -T backend python -m flask --app app promote-admin owner@example.test
```

Uploads support unencrypted PDF, PNG, JPEG, TIFF, and WebP up to 10 MiB. The English OCR worker extracts embedded PDF text and uses Tesseract for scanned pages and images. It uses jobs with timed leases and processes up to 50 pages or frames per document. When processing fails, the status appears in Details and the authorized download remains available. Queue uploads made before OCR was added with:

```powershell
docker compose exec -T backend python -m flask --app app backfill-ocr
```

## REST API

Protected routes accept `Authorization: Bearer <token>`. Login returns an eight-hour token. The browser holds it in memory. Signup creates an ordinary user.

| Method | Path | Input or behavior |
|---|---|---|
| GET | `/api/health` | Reports Flask-to-MongoDB connectivity |
| GET | `/api/auth/divisions` | Lists division IDs |
| POST | `/api/auth/register` | JSON `email`, `password`, `division_id` |
| POST | `/api/auth/login` | JSON `email`, `password` |
| GET / POST | `/api/auth/me` / `/api/auth/logout` | Current account / revoke token |
| GET / POST | `/api/metadata-fields` | Read active fields / create a field as admin. Admins can read retired fields with `?all=1`. |
| PATCH | `/api/metadata-fields/<key>` | Edit labels, choices, and active/required flags as admin |
| POST | `/api/documents/upload` | Multipart `file` and optional JSON `metadata`. Use stable field keys and option IDs, for example `{"report_type":"financial"}`. |
| GET | `/api/documents` | Division-scoped listing. Supports `page`, `Division`, metadata keys and labels, including `?Report%20Type=Financial`. |
| GET | `/api/documents/<doc_id>` | Details or the restricted request view |
| GET | `/api/documents/<doc_id>/download` | Original bytes for the owning division or approved requester |
| POST | `/api/access/request` | JSON `doc_id` |
| POST | `/api/access/approve`, `/api/access/reject` | JSON `request_id` |
| GET | `/api/access/requests` | `direction=incoming` or `direction=outgoing`, optional `page` |
| GET | `/api/search` | Division-scoped titles, metadata, and OCR text. Requires `q`; accepts `page`. |

Custom metadata labels and option labels can change while stable keys and IDs preserve existing records. Historic free-text metadata is still visible. Division cannot be reassigned in Settings. A cross-division approval covers one user and one document. Search and Hub listings are scoped to the user's own division.

## Verify

```powershell
docker compose exec -T frontend nginx -t
docker compose exec -T backend python smoke_auth.py
docker compose exec -T ocr python smoke_project.py | Tee-Object -FilePath test_report.txt
```

Both smoke scripts create and remove their own temporary MongoDB databases. The project suite generates valid PDF and image fixtures. The assignment's [public test script](https://github.com/rithish-sripaul-triad-ai/triad-ai-interns-dms/blob/main/test_api.py) sends an anonymous upload and writes a PDF-like stub when its fixture is missing. This project requires a valid file and authorization. The project suite exercises the authenticated HTTP contracts.

## Troubleshooting

- If Flask cannot reach MongoDB, check that `mongo` is healthy and that the URI uses the Compose service name. After changing `.env`, run `docker compose up -d` to apply the new environment.
- Use `docker compose logs --tail=80 backend frontend ocr` for startup and processing errors.
- Nginx serves the static frontend and proxies `/api` to Flask inside Docker. The direct health endpoint on port 5001 helps distinguish a Flask error from a proxy error.
- `docker compose down` preserves the `mongo_data` named volume. Use `down -v` only for a disposable stack whose data you want to erase.

The root `requirements.txt` delegates to the backend manifest. Docker installs the Python dependencies during image builds. The static frontend uses browser modules and requires no JavaScript packages or build step. Keep local `.env`, generated test reports, and document data out of Git.
