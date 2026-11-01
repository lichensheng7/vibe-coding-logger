FROM node:24-alpine
RUN apk add --no-cache tzdata \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
