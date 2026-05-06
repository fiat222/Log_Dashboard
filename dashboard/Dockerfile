FROM nginxinc/nginx-unprivileged:1.25

COPY --chown=nginx:nginx dashboard/ /usr/share/nginx/html/
COPY --chown=nginx:nginx docs-site/build/ /usr/share/nginx/html/docs/
COPY --chown=nginx:nginx dashboard/nginx.conf.template /etc/nginx/templates/default.conf.template

# nginx-unprivileged listens on 8080 by default (USER nginx already set)
EXPOSE 8080
