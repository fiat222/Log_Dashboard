FROM nginxinc/nginx-unprivileged:1.25

COPY --chown=nginx:nginx apps/web/ /usr/share/nginx/html/
COPY --chown=nginx:nginx apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template

# nginx-unprivileged listens on 8080 by default (USER nginx already set)
EXPOSE 8080
