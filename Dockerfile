# One image, two commands: api (default) and worker (override CMD in infra).
#
# Build context is the workspace root (the parent of all invai-* repos), not this directory:
# package.json links @invai/contracts via `link:../invai-contracts`, a sibling repo, so pnpm
# and the build need it on disk at that relative path. See invai-infra/local/docker-compose.yml
# (the `full` profile) and invai-infra/sst.config.ts for how the context/dockerfile are set.
FROM node:24-slim AS build
WORKDIR /build
RUN corepack enable
COPY invai-contracts ./invai-contracts
COPY invai-backend/package.json invai-backend/pnpm-lock.yaml ./invai-backend/
WORKDIR /build/invai-backend
RUN pnpm install --frozen-lockfile
COPY invai-backend/. .
RUN pnpm build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /build/invai-backend/dist ./dist
COPY --from=build /build/invai-backend/node_modules ./node_modules
COPY --from=build /build/invai-backend/package.json ./
EXPOSE 3000
CMD ["node", "dist/server.js"]
