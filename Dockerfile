# syntax=docker/dockerfile:1
# LinkBag: Bun + Hono backend, React UI, SingleFile capture in headless Chromium.

FROM oven/bun:1.2.19 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run build

FROM oven/bun:1.2.19 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Chromium is required for SingleFile captures. Liberation fonts keep common
# Latin pages legible while the browser builds the archive.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV LINKBAG_CHROME_PATH=/usr/bin/chromium

# Only production dependencies are needed to serve the UI and run captures.
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --production --frozen-lockfile
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/plugins ./plugins
COPY --from=build /app/dist ./dist
COPY --from=build /app/LICENSE ./LICENSE

EXPOSE 8787 8788

CMD ["bun", "run", "start"]
