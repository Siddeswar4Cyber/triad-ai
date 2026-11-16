# TRIAD AI Document Management System

This is the first part of TRIAD AI. It brings up a React status page, a Flask API, and MongoDB. The page asks Flask to ping MongoDB so you can see whether the three pieces are talking to each other.

## Run it locally

Start Docker Desktop and wait for it to finish starting. Open PowerShell in the project folder. If you don't already have a `.env` file, copy the example:

```powershell
Copy-Item .env.example .env
```

Build and start the containers:

```powershell
docker compose up --build -d
docker compose ps
```

Open [the status page](http://127.0.0.1:5174/). Once MongoDB is healthy, select **Check again**. You should see **Flask API: Reachable** and **MongoDB: Connected**.

## Check the API

```powershell
curl.exe -i http://127.0.0.1:5001/api/health
```

HTTP `200` means MongoDB answered the ping. HTTP `503` means Flask responded but couldn't complete the MongoDB check.

If MongoDB shows **Unavailable**, check that the `mongo` container is healthy with `docker compose ps`. Then check that the project’s `.env` contains:

```dotenv
MONGODB_URI=mongodb://mongo:27017
```

Inside the Flask container, `127.0.0.1` points to Flask's own container. `mongo` is the name Docker uses to find the database container. After changing `.env`, recreate the backend so it picks up the new value:

```powershell
docker compose up -d --no-deps --force-recreate backend
```

## Build and stop

To check that the frontend builds, run this while the containers are up:

```powershell
docker compose exec frontend npm run build
```

When you're done, run `docker compose down`. MongoDB keeps its data in a Docker volume so it's there the next time you start the project.

## Authentication and divisions

Compose waits for MongoDB to be healthy. The backend then creates the
unique email and session expiry indexes before serving requests. If
initialization fails, inspect `docker compose logs --tail=80 backend`.
After fixing the reported database issue, run `docker compose up -d backend`.
The application database defaults to `triad_dms` and can be set through
`MONGODB_DATABASE`.

On the frontend, choose **Create an account**, select Division A or
Division B, and sign in. The account panel displays your division and
offers **Sign out**. Division self-selection and the Docker stack are
for local development.

| Endpoint | Input |
|---|---|
| `GET /api/auth/divisions` | None |
| `POST /api/auth/register` | JSON with `email`, `password`, and `division_id` |
| `POST /api/auth/login` | JSON with `email` and `password` |
| `GET /api/auth/me` | `Authorization: Bearer <token>` |
| `POST /api/auth/logout` | `Authorization: Bearer <token>` |

Use `division-a` or `division-b` for the division ID. Login returns an
eight-hour bearer token. The frontend keeps it in memory, so refreshing
requires signing in again.

Run the authentication smoke test inside Docker:

```powershell
docker compose exec -T backend python smoke_auth.py
```

The test creates and removes its own temporary MongoDB database. It
checks both divisions, input validation, uniqueness, login, profile
access, token expiry, and logout revocation. Verify the browser workflow
by registering, signing in, checking the displayed division, and signing
out. The status panel should still show MongoDB as connected.

For a host-side Python install, the root `requirements.txt` delegates to
`backend/requirements.txt`. Keep `.env` and generated files local when
committing. Include `.env.example`, the Docker and Compose files, and the
frontend lockfile so a fresh clone can run the same setup.

### Frontend layout

The React entry point renders the account and system status sections.
`frontend/src/AuthPanel.jsx` owns the sign-in, signup, and sign-out flows.
`frontend/src/styles.css` provides the responsive layout and shared
form styles. Vite forwards relative API requests to Flask through the
existing Compose network.

Open the app at a desktop and a narrow mobile width. Check keyboard
navigation, password visibility, signup validation, division selection,
and the system status refresh. Then sign in and out. Run
`docker compose exec -T frontend npm run build` before committing the
frontend files and README to your feature branch.

## Document upload

Sign in and use **Upload document** in the account panel. The file is
stored in GridFS, and the document record in MongoDB stores its owner,
uploader, original file reference, and metadata. The server assigns the
owning division from the signed-in account.

`POST /api/documents/upload` requires a bearer token and multipart form
data with one `file` part and an optional `metadata` part containing a
JSON object, for example `{"Report Type":"Financial"}`. Metadata values
can be text, numbers, or booleans. A supplied Division must match the
signed-in account. Successful requests return HTTP 201 and a `doc_id`.
The size limit is 10 MiB. Supported formats are unencrypted PDF, PNG,
JPEG, TIFF, and WebP.

The Report Type input accepts free text until the metadata Settings
component supplies configured fields. After pulling changes to the
backend dependencies, run `docker compose up --build -d backend`.
