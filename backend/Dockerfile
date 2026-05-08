FROM python:3.12-slim

WORKDIR /app

# Install system deps + Docker CLI (needed for container-down detection and backup trigger)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc curl wget gnupg ca-certificates \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
       https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Non-root runtime user
RUN groupadd -g 10001 app && useradd -u 10001 -g 10001 -s /usr/sbin/nologin -M app \
    && chown -R 10001:10001 /app
USER 10001:10001

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--workers", "2", "--timeout-keep-alive", "30"]
