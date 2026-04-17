FROM alpine:3.19

RUN apk add --no-cache postgresql16-client curl bash tar

# Configure timezone (optional but good for logs)
RUN apk add --no-cache tzdata
ENV TZ=Asia/Bangkok

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# Run everyday at 02:00 AM (CRON syntax)
RUN echo "0 2 * * * /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1" > /etc/crontabs/root

CMD ["crond", "-f", "-l", "2"]
