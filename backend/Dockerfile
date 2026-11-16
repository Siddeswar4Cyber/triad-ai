FROM python:3.12-slim AS backend

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY app.py auth.py documents.py metadata_fields.py access_requests.py ocr_worker.py smoke_auth.py ./
CMD ["sh", "-c", "python -m flask --app app init-auth && python -m flask --app app init-metadata && python -m flask --app app init-access && exec python -m flask --app app run --debug --host 0.0.0.0 --port 5000"]
FROM backend AS ocr
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils \
    && rm -rf /var/lib/apt/lists/*
ENV OMP_THREAD_LIMIT=1
CMD ["python", "ocr_worker.py"]
