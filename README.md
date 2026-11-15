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
