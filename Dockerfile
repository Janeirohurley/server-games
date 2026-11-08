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

# --- élagage: binaires natifs d'autres plateformes -------------------------
#
# uWebSockets.js livre 24 binaires precompiles — macOS, Windows, ARM, et
# quatre versions d'ABI chacun — soit 125 Mo, la moitie de node_modules.
# L'image tourne sur linux/amd64 et rien d'autre: les 20 autres ne seront
# jamais ouverts.
#
# Le paquet lui-meme arrive par `@colyseus/uwebsockets-transport`, une
# dependance OPTIONNELLE de `colyseus` que bun installe par defaut. Ce
# serveur n'utilise pas ce transport (src/app.config.ts construit un
# `WebSocketTransport`), donc meme le binaire conserve ne se charge pas.
# On garde quand meme toutes les variantes linux x64: la selection d'ABI
# se fait a l'execution, et si quelqu'un bascule un jour de transport,
# l'image continue de fonctionner au lieu de casser a l'import.
RUN find node_modules/uWebSockets.js -name 'uws_*.node' \
      ! -name 'uws_linux_x64_*.node' -delete 2>/dev/null || true


# ---------------------------------------------------------------------------
# runner
#
# `-slim` plutot que l'image par defaut: meme binaire bun, meme glibc, mais
# une base Debian depouillee — 70 Mo de moins, et rien de ce qui disparait
# n'est utilise ici. Le shell reste present, donc `docker exec sh` continue
# de marcher pour diagnostiquer en production (ce que `-distroless`, plus
# petit encore, couterait).
#
# Pas d'alpine: les binaires natifs du cache de dependances sont lies a
# glibc et musl les refuserait.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.2-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=2567

COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/build ./build
COPY --chown=bun:bun package.json ./package.json

USER bun

EXPOSE 2567

CMD ["bun", "build/index.js"]
