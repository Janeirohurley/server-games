# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# deps: full dependency tree (TypeScript and friends are needed to build).
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.2 AS deps

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile


# ---------------------------------------------------------------------------
# builder: tsc -> build/
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.2 AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN bun run build


# ---------------------------------------------------------------------------
# prod-deps: runtime dependencies only, resolved in parallel with the build.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.2 AS prod-deps

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --production


# ---------------------------------------------------------------------------
# runner
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.2 AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=2567

COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/build ./build
COPY --chown=bun:bun package.json ./package.json

USER bun

EXPOSE 2567

CMD ["bun", "build/index.js"]
