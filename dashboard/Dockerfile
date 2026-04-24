FROM nginx:1.25

COPY dashboard/ /usr/share/nginx/html/
COPY docs-site/build/ /usr/share/nginx/html/docs/
COPY dashboard/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80
