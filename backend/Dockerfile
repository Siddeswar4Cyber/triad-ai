FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY app.py ./
CMD ["python", "-m", "flask", "--app", "app", "run", "--debug", "--host", "0.0.0.0", "--port", "5000"]