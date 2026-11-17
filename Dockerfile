# Ganttraah: the application image. Runs on OpenShift 4.x (random non-root user) and on plain Docker.
#
#   docker build -t gantraah:1.7 .
#
# One process: Node.js serves the API, the built web pages and live updates (WebSocket, /ws) on port 8080.
# The data is kept outside the container, so deleting the pod loses nothing:
#   - DATABASE_URL set   -> an external PostgreSQL (15 or newer)
#   - DATABASE_URL empty -> the embedded database, in /data (mount a PersistentVolumeClaim there)
# Build on a machine with internet access (npm), then push the image to the cluster's registry.

# ---- 1. the web pages (React + TypeScript, built by Vite into static files)
FROM node:24-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---- 2. the server (Node.js, production dependencies only) with the built pages
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data/pglite \
    HOME=/tmp
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/src server/src
COPY --from=client /app/client/dist client/dist
# OpenShift runs the container as a random user that belongs to group 0 (root group): the files are
# given to group 0, the application stays read-only, and only /data is writable
RUN mkdir -p /data && chgrp -R 0 /app /data && chmod -R g=u /data && chmod -R g=rX /app
USER 1001
VOLUME ["/data"]
EXPOSE 8080
# plain Docker only; on OpenShift the readiness/liveness probes in the deployment do this
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# node runs as process 1: it receives the stop signal (SIGTERM) and closes the database cleanly.
# The embedded database (like any PostgreSQL) opens only under the user id that created it: on
# OpenShift every pod of a project runs with the project's fixed user id, so this always holds there.
CMD ["node", "server/src/index.js"]
