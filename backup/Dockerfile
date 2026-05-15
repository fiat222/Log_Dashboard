FROM alpine:3.19

# Schedule lives in backend (APScheduler). Container is just a triggered worker.
RUN apk add --no-cache curl bash tar tzdata python3 \
    && rm -rf /var/cache/apk/*
ENV TZ=Asia/Bangkok

# Non-root runtime user
RUN addgroup -g 10001 backup && adduser -u 10001 -G backup -s /sbin/nologin -D backup \
    && mkdir -p /backups /home/backup \
    && chown -R 10001:10001 /backups /home/backup

COPY --chown=10001:10001 backup.sh   /usr/local/bin/backup.sh
COPY --chown=10001:10001 server.py   /usr/local/bin/server.py
COPY --chown=10001:10001 start.sh    /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/start.sh

USER 10001:10001
WORKDIR /home/backup
EXPOSE 8080

CMD ["/usr/local/bin/start.sh"]
