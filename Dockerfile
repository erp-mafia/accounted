# ── Stage 1: Base ──
FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS base
# `apk upgrade` patches OS packages (e.g. libssl3/libcrypto3) that have fixes
# published after the pinned base digest was built, so the Trivy image scan in
# CI doesn't fail on fixable Alpine CVEs. The digest stays pinned for a
# reproducible starting point; only security patches float on top.
RUN apk upgrade --no-cache && apk add --no-cache libc6-compat

# ── Stage 2: Dependencies ──
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 3: Builder ──
FROM base AS builder
WORKDIR /app

ARG EXTENSIONS_PRESET=self-hosted

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Apply extension preset (must happen before build: prebuild hook
# runs setup:extensions which reads extensions.config.json)
COPY docker/extensions.${EXTENSIONS_PRESET}.json ./extensions.config.json

# Build with placeholder sentinel values for NEXT_PUBLIC_* vars.
# These get replaced at runtime by docker-entrypoint.sh so the image
# is generic and reusable across different Supabase projects.
ENV NEXT_PUBLIC_SUPABASE_URL=__NEXT_PUBLIC_SUPABASE_URL__
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=__NEXT_PUBLIC_SUPABASE_ANON_KEY__
ENV NEXT_PUBLIC_APP_URL=__NEXT_PUBLIC_APP_URL__
ENV NEXT_PUBLIC_VAPID_PUBLIC_KEY=__NEXT_PUBLIC_VAPID_PUBLIC_KEY__
ENV NEXT_PUBLIC_SELF_HOSTED=__NEXT_PUBLIC_SELF_HOSTED__
ENV NEXT_PUBLIC_REQUIRE_MFA=__NEXT_PUBLIC_REQUIRE_MFA__
# Keep the branding placeholder intact through prebuild's inject script so
# docker-entrypoint.sh can substitute the runtime value into public/sw.js.
ENV NEXT_PUBLIC_BRANDING_APP_NAME=__NEXT_PUBLIC_BRANDING_APP_NAME__

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ── Stage 4: Runner ──
FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS runner
WORKDIR /app

# Patch OS packages (libssl3/libcrypto3, …) with fixes published after the
# pinned base digest, so CI's Trivy scan doesn't flag fixable Alpine CVEs. No
# su-exec or curl needed: the entrypoint runs unprivileged as nextjs and the
# healthcheck uses BusyBox wget. The runtime runs `node server.js` and never
# invokes npm, so we delete the base image's bundled npm CLI: its vendored deps
# (picomatch, tar, brace-expansion, ip-address) are the packages Trivy flags on
# this image: removing npm clears them at the source and shrinks the attack
# surface.
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 -G nodejs nextjs

# /app at runtime is split across the read-only image layer and tmpfs mounts:
#   /app/server.js, /app/node_modules/, /app/package.json   : image (read-only)
#   /app/.next/                                              : tmpfs (writable)
#   /app/public/                                             : tmpfs (writable)
# The entrypoint runs UNPRIVILEGED as nextjs: it copies the templates from
# /opt/gnubok-template/ into the nextjs-owned tmpfs mounts, substitutes the
# NEXT_PUBLIC_* placeholders, then drops the write bits. Because it never needs
# to chown or setuid, the container runs under docker-compose's `cap_drop: ALL`
# + `read_only: true` with no added capabilities.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone/server.js ./server.js
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone/package.json ./package.json

# Baked-in templates for runtime population of the tmpfs mounts.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone/.next /opt/gnubok-template/.next
COPY --from=builder --chown=nextjs:nodejs /app/.next/static /opt/gnubok-template/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public /opt/gnubok-template/public

# Pre-create the tmpfs mount points (empty in the image layer; the entrypoint
# fills them at startup). Owned by nextjs so the unprivileged entrypoint can
# write into the tmpfs mounted over them.
RUN mkdir -p /app/.next/cache /app/public && \
    chown nextjs:nodejs /app /app/.next /app/.next/cache /app/public

COPY --chmod=755 --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
