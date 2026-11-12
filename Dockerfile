# Ganttraah - application image. Build on a machine with internet, then move to the closed network
# with deploy/build-offline.ps1 (docker save / docker load).
FROM node:24-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev
COPY server/src server/src
COPY --from=client /app/client/dist client/dist
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8080/healthz || exit 1
CMD ["node", "server/src/index.js"]
