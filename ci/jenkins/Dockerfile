FROM jenkins/jenkins:lts-jdk17

USER root

ENV PLAYWRIGHT_BROWSERS_PATH=/var/jenkins_home/.cache/ms-playwright

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      python3 \
      python3-pip \
      python3-venv \
      nodejs \
      npm \
      libglib2.0-0 \
      libnss3 \
      libnspr4 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libdbus-1-3 \
      libxcb1 \
      libxkbcommon0 \
      libx11-6 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libpango-1.0-0 \
      libcairo2 \
      libasound2t64 \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ARG DOCKER_COMPOSE_VERSION=v2.29.7
RUN curl -fsSL "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64" \
      -o /usr/local/bin/docker-compose \
    && chmod +x /usr/local/bin/docker-compose \
    && docker-compose version

USER jenkins
