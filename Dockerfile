FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY local_server ./local_server

CMD ["sh", "-c", "uvicorn local_server.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
