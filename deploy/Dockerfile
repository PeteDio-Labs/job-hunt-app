# syntax=docker/dockerfile:1.7
FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
RUN bun install --production --frozen-lockfile || bun install --production
# (no lockfile yet at first build; falls through to non-frozen install)

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

RUN addgroup -S app && adduser -S -G app app && chown -R app:app /app
USER app

EXPOSE 3014
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3014/health > /dev/null || exit 1

# Apply migrations on boot, then start the server.
CMD ["sh", "-c", "bun run src/db/migrate.ts && bun run src/index.ts"]
