# One image, five commands (T-30-3): api (default CMD), worker and the three release CLIs.
#   node dist/api/server.js | node dist/worker/index.js
#   node dist/db/bootstrap-cli.js | dist/db/migrate-cli.js | dist/db/reference-seed-cli.js
# Migrations are at /app/drizzle (migrate-cli resolves them from <app>/drizzle).
#
# Build context is the workspace root (the parent of all invai-* repos), not this directory:
# package.json links @invai/contracts via `link:../invai-contracts`, a sibling repo. The root is
# not a git repo, so the ignore file is BuildKit's per-Dockerfile one, Dockerfile.dockerignore.
#   docker build -f invai-backend/Dockerfile .
# Every base image is pinned by digest. To bump: `docker buildx imagetools inspect node:24-slim`.

# ---- build: all dependencies, compile with tsup -------------------------------------------
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /build
# pnpm pinned with the tarball sha512 (same version as packageManager); corepack refuses a mismatch.
RUN corepack enable && corepack prepare pnpm@12.6.0+sha512.3ef68f951cb111ac204b4a5a16f0b2ddf0da56a96e0413e81d855d9f0b55ef926714709028e1cd00c405c2c5fb7b9e8ec4dc46777c805d0373c2f2ff00fd20ec --activate
COPY invai-contracts ./invai-contracts
WORKDIR /build/invai-backend
COPY invai-backend/package.json invai-backend/pnpm-lock.yaml invai-backend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY invai-backend/tsup.config.ts invai-backend/tsconfig.json ./
COPY invai-backend/src ./src
RUN pnpm build

# ---- prod-deps: production dependencies only ----------------------------------------------
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS prod-deps
WORKDIR /build
# pnpm pinned with the tarball sha512 (same version as packageManager); corepack refuses a mismatch.
RUN corepack enable && corepack prepare pnpm@12.6.0+sha512.3ef68f951cb111ac204b4a5a16f0b2ddf0da56a96e0413e81d855d9f0b55ef926714709028e1cd00c405c2c5fb7b9e8ec4dc46777c805d0373c2f2ff00fd20ec --activate
# @invai/contracts is bundled into dist by tsup; pnpm only needs the link target to exist.
COPY invai-contracts/package.json ./invai-contracts/package.json
WORKDIR /build/invai-backend
COPY invai-backend/package.json invai-backend/pnpm-lock.yaml invai-backend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- certs: RDS CA bundle, fetched at build time and checked against a pinned sha256 -------
# sst.config.ts sets NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem (RDS uses verify-full).
# AWS republishes this file when it rotates CAs: a checksum failure here is the signal to review
# the new bundle and bump the hash, not to drop the check.
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS certs
ADD --checksum=sha256:fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /certs/rds-global-bundle.pem
# ADD writes the file 0600 root; the runtime user (uid 10001) must be able to read it.
RUN chmod 0444 /certs/rds-global-bundle.pem

# ---- runtime ------------------------------------------------------------------------------
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 invai && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin invai
# Scan fixes (T-31-4, ops/scans). perl-base: the pinned base ships 5.36.0-7+deb12u3, fixed in
# deb12u4 (3 CRITICAL, 4 HIGH); drop this upgrade once the base digest carries it. npm, npx and
# corepack are never run in the container (`node dist/...` only) and bundle HIGH-severity
# brace-expansion, ip-address, tar and undici, so they are removed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends --only-upgrade perl-base \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
     /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
     /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn*
COPY --from=prod-deps /build/invai-backend/node_modules ./node_modules
# better-auth drags drizzle-kit, vitest and typescript 7 into the production graph; their native
# Go binaries (esbuild, tsc) carry Go stdlib CVEs and are never executed here. The pnpm store
# entries are deleted; nothing imports them at runtime (checked by the full-profile golden path).
RUN rm -rf ./node_modules/.pnpm/@esbuild+* ./node_modules/.pnpm/@typescript+typescript-*
COPY --from=build /build/invai-backend/dist ./dist
COPY invai-backend/drizzle ./drizzle
COPY invai-backend/package.json ./package.json
COPY --from=certs /certs/rds-global-bundle.pem ./certs/rds-global-bundle.pem
USER 10001:10001
EXPOSE 3000
# API probe. The worker has no HTTP listener and no probe: the compose `worker` service turns this
# check off, and ECS ignores Dockerfile HEALTHCHECKs (health is set on the service).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/api/server.js"]
