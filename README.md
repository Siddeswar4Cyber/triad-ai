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

Open [the workspace](http://127.0.0.1:5174/). MongoDB's health check gates service startup. Flask creates authentication and request indexes and seeds Division A, Division B, and Report Type if needed. Keep `MONGODB_URI=mongodb://mongo:27017` for the bundled database. `MONGODB_DATABASE` defaults to `triad_dms`. The Docker stack and self-selected divisions are intended for local demonstration.

## Demo credentials

After completing the [demo seed setup](#realistic-demo-dataset), use these accounts
at [the sign-in page](http://127.0.0.1:5174/).

**Password for all demo accounts:** `TriadDemo2026!`

| Role | Division | Email |
|---|---|---|
| Global admin | Division A | `maya.rao@triad.example.test` |
| Regular user | Division A | `arun.mehta@triad.example.test` |
| Regular user | Division B | `sofia.martinez@triad.example.test` |
| Regular user (reviewer) | Division A | `nisha.shah@triad.example.test` |

The global admin opens the Admin dashboard. Regular users and reviewers open the
Document Hub. The [full demo account list](#realistic-demo-dataset) includes all
15 accounts across the five divisions.

## Try the workflow

To open the app from a phone, connect the phone and this PC to the same Wi-Fi
and browse to `http://<PC-Wi-Fi-IPv4>:5174/`. Find the PC address with
`Get-NetIPAddress -InterfaceAlias Wi-Fi -AddressFamily IPv4` in PowerShell.
The frontend binds to all host interfaces by default. Set
`FRONTEND_BIND_ADDRESS=127.0.0.1` in the root `.env` to restrict it to this PC,
then run `docker compose up -d frontend`.

Windows Firewall must allow inbound TCP port 5174 from the local subnet on the
Wi-Fi interface. Keep Docker Desktop and the PC running. The phone's API requests
use the frontend proxy, so use port 5174 for the mobile URL. Some campus or guest
Wi-Fi networks isolate devices; use a shared hotspot if peer connections are blocked.

1. Create regular accounts in Division A and Division B, plus a separate account for administration. Run the command below with the admin account's email, then sign in with that account.
2. Sign in as the regular Division A user, select a Report Type in **Upload**, and upload a file. The server assigns the owning division.
3. In **Documents**, filter by metadata, open the file, and copy its direct link. Choose **Refresh OCR status** until the details view shows Ready. In **Search**, enter a distinctive word from the document.
4. Sign in as the Division B account and open the copied link. Select **Request access**. The requester can check **Requests → Sent**.
5. Sign in as Division A and use **Requests → Incoming** to approve or reject the request. After approval, sign in as the Division B requester and download the file from the direct link or Sent history.

```powershell
docker compose exec -T backend python -m flask --app app promote-admin maya.rao@triad.example.test
```

Uploads support unencrypted PDF, PNG, JPEG, TIFF, and WebP up to 10 MiB. The English OCR worker extracts embedded PDF text and uses Tesseract for scanned pages and images. It uses jobs with timed leases and processes up to 50 pages or frames per document. When processing fails, the status appears in Details and the authorized download remains available. Queue uploads made before OCR was added with:

```powershell
docker compose exec -T backend python -m flask --app app backfill-ocr
```

## Global administration

Promoted accounts sign into the dedicated **Admin** dashboard. Its Documents tab
includes search by title, metadata, and OCR text across divisions, with a division filter.
Admins can manage divisions, review incoming requests, preview and download files
across divisions, and edit each document's metadata from its row. Admins can also
add or edit shared text and dropdown fields using **Admin → Documents → Manage
metadata fields**, including required status and active or retired choices.
Regular accounts use the
division-scoped Document Hub. Advanced Search also includes individual documents
approved for the signed-in user. Regular users need approval for their
account and document to download outside their own division.
Deactivation blocks new signups and uploads in that division. Existing users,
documents, and requests remain available under their normal permissions. Division
IDs and stored ownership references stay the same when the name changes.

### Assignment policy extension

Global administrators can view and download documents and decide access requests
across all divisions. This is an intentional product extension requested by the
project owner. The original assignment describes approval by a user or admin in
the owning division. Regular users follow that rule: their uploads and Hub listings
are division-scoped, and access to another division's document requires individual
approval. Advanced Search includes their own division and individually approved
documents.

## REST API

The Admin Activity log records new account registrations, sign-ins and sign-outs,
uploads, download requests served, access requests and decisions, division changes,
metadata changes, and admin promotions from the time this feature is enabled.
It stores the actor, division, time, and relevant record details, excluding credentials
and file contents. Existing historical actions are not backfilled. A logging storage
failure is reported in the backend logs while the completed user action remains successful.

Protected routes accept `Authorization: Bearer <token>`. Login returns an eight-hour token. The browser keeps the token in the current tab session so full-page navigation preserves sign-in. Signup creates an ordinary user.

| Method | Path | Input or behavior |
|---|---|---|
| GET | `/api/health` | Reports Flask-to-MongoDB connectivity |
| GET | `/api/auth/divisions` | Lists active divisions for signup |
| GET / POST | `/api/admin/divisions` | Admin-only division list and creation. Create with JSON `name`. |
| PATCH | `/api/admin/divisions/<id>` | Admin-only rename or update `active` |
| GET | `/api/admin/documents` | Admin-only cross-division list and search. Accepts `division_id`, `page`, `q`, and `scope` (`all`, `title`, `metadata`, or `text`). |
| GET | `/api/admin/requests` | Admin-only incoming requests across divisions. Accepts `division_id`, `status`, and `page`. |
| GET | `/api/admin/activity` | Admin-only activity history across divisions. Accepts `category`, `action`, and `page`; returns 25 events per page and recorded totals for accounts, uploads, and approvals. |
| POST | `/api/auth/register` | JSON `email`, `password`, `division_id` |
| POST | `/api/auth/login` | JSON `email`, `password` |
| GET / POST | `/api/auth/me` / `/api/auth/logout` | Current account / revoke token |
| GET / POST | `/api/metadata-fields` | Read active fields / create a field as admin. Admins can read retired fields with `?all=1`. |
| PATCH | `/api/metadata-fields/<key>` | Edit labels, choices, and active/required flags as admin |
| POST | `/api/metadata-fields/report_type/options` | Signed-in users can add a Report Type with JSON `label`. Existing active names are reused without case sensitivity. |
| POST | `/api/documents/upload` | Multipart `file` and optional JSON `metadata`. Use stable field keys and option IDs, for example `{"report_type":"financial"}`. |
| GET | `/api/documents` | Division-scoped listing. Supports `page`, `Division`, metadata keys and labels, including `?Report%20Type=Financial`. |
| GET | `/api/documents/<doc_id>` | Details or the restricted request view |
| GET / PATCH | `/api/documents/<doc_id>/metadata` | Admin-only document metadata editor. PATCH accepts changed active field keys in a JSON `metadata` object. |
| GET | `/api/documents/<doc_id>/download` | Original bytes for admins, users in the owning division, or the approved requester |
| GET | `/api/documents/<doc_id>/preview` | Preview for admins, owning-division users, or the approved requester. PDF and TIFF pages render as PNG with a zero-based `frame` parameter. |
| POST | `/api/access/request` | JSON `doc_id` |
| POST | `/api/access/approve`, `/api/access/reject` | JSON `request_id`. Regular users can decide in their division. Admins can decide across divisions. |
| GET | `/api/access/requests` | `direction=incoming` or `direction=outgoing`, optional `page` and `status` (`pending`, `approved`, or `rejected`) |
| GET | `/api/search` | Searches titles, metadata, and OCR text in the user's division plus documents approved for that user. Requires `q`; accepts `page` and `scope` (`all`, `title`, `metadata`, or `text`). |

Custom metadata labels and option labels can change while stable keys and IDs preserve existing records. Historic free-text metadata is still visible. Editing metadata cannot change document ownership. A cross-division approval covers one user and one document. The Hub lists the user's own division, while Search also includes documents approved for that user.

## Verify

### Realistic demo dataset

The fresh demo dataset contains 5 divisions, 15 accounts (5 administrators and 10
regular users), 25 readable documents in GridFS, 5 metadata fields, and 15 access
requests. Each division owns 5 documents. Pending, approved, and rejected requests
each have 5 examples. PDF, PNG, JPEG, TIFF, and WebP each have 5 originals.
The OCR worker processes the seeded originals normally. The activity dashboard
uses events emitted while the seed calls the application's existing APIs.

All demo accounts use the password `TriadDemo2026!`. Append
`@triad.example.test` to the account names below.

| Division | Administrator | Contributor | Reviewer |
|---|---|---|---|
| Division A (Finance) | maya.rao | arun.mehta | nisha.shah |
| Division B (Sales) | daniel.brooks | sofia.martinez | liam.chen |
| Operations | aisha.khan | noah.williams | priya.nair |
| People and Culture | emma.wilson | ravi.patel | zoe.anderson |
| Research and Development | oliver.smith | ananya.iyer | ethan.davis |

The administrator opens the Admin dashboard. Contributors and reviewers use the
regular workspace. Each contributor has one approved document from another
division that also appears in Advanced Search. Reviewers in the same division do
not inherit the contributor's cross-division approval.

Check the existing seeded data without changing it:

```powershell
docker compose exec -T backend python seed_demo.py --database triad_dms --verify-only --require-ocr
```

The seeder's `--reset` mode deletes every record in the explicitly named database
before inserting fresh records. Confirm the environment, stop application writes,
and take a MongoDB backup before using it. Collection definitions and indexes are
preserved. Backups under `local-data/backups/` are excluded from Git.

To populate a fresh local installation with the documented demo accounts, run
the following only against a fresh database or after confirming a complete reset
and taking a backup:

```powershell
docker compose stop backend ocr
docker compose run --rm --no-deps -T backend python seed_demo.py --database triad_dms --reset
docker compose up -d backend ocr
```

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

The root `requirements.txt` delegates to the backend manifest. Docker installs the Python dependencies during image builds. The frontend serves separate HTML pages for sign-in, registration, documents, details, upload, requests, search, admin, and system status. It uses browser modules and requires no JavaScript packages or build step. Keep local `.env`, generated test reports, and document data out of Git.
