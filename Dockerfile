FROM node:24.14.0-bookworm-slim AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:24.14.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gosu tini \
    && mkdir -p /data \
    && chown node:node /data \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/phosphene-entrypoint
RUN chmod 0755 /usr/local/bin/phosphene-entrypoint

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/phosphene-entrypoint"]
CMD ["node", "--max-old-space-size=128", "--max-semi-space-size=4", "dist/server/index.js"]
