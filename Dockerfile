FROM python:3.12-alpine
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY server.py storage-mode.json ./
COPY portable_store.py ./portable_store.py
COPY web ./web
USER 10001:10001
EXPOSE 8765
CMD ["python", "server.py", "--bind", "0.0.0.0", "--data-dir", "/data/working", "--shared-dir", "/data/shared"]

