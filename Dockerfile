# syntax=docker/dockerfile:1

# An MCP stdio server in a container. There is no port and no HTTP surface:
# the host talks to it over stdin and stdout, so it must be run with `-i` and
# without `-t` (a TTY would corrupt the JSON-RPC framing).
#
#   docker run --rm -i -e COMPANIES_HOUSE_API_KEY=... ghcr.io/OWNER/companies-house-screening-mcp

FROM node:24-alpine AS build

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall the world.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build


FROM node:24-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
# `--ignore-scripts` because no production dependency here needs a build step,
# and a postinstall script running as part of an image build is a supply-chain
# surface with nothing to gain from it.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

# The node image ships an unprivileged `node` user. The server reads a public
# API and writes a cache; it never needs root.
ENV CH_CACHE_DIR=/home/node/.cache/companies-house-screening-mcp
RUN mkdir -p "$CH_CACHE_DIR" && chown -R node:node "$CH_CACHE_DIR"
USER node

# Diagnostics go to stderr; stdout belongs to the transport.
ENTRYPOINT ["node", "dist/bin.js"]
