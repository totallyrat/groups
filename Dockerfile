# Groups — one small image, no npm dependencies.
FROM node:22-alpine

# ffmpeg powers "Save the whole day" (stitching a group's clips into one MP4).
# Without it the app still works and saves clips one at a time.
RUN apk add --no-cache ffmpeg tini

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY web ./web
COPY scripts ./scripts

# Icons and splash screens are generated, not committed as binaries.
RUN node scripts/make-icons.mjs

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

RUN mkdir -p /data && addgroup -g 1001 groups && adduser -D -u 1001 -G groups groups \
 && chown -R groups:groups /data /app
USER groups

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--no-warnings", "server/server.mjs"]
