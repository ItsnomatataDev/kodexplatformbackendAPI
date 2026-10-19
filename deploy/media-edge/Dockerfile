FROM nginx:1.28-alpine
RUN mkdir -p /var/cache/nginx/media && chown -R 101:101 /var/cache/nginx
COPY media-cors.conf /etc/nginx/media-cors.conf
USER 101:101
ENTRYPOINT ["nginx", "-g", "daemon off;"]
