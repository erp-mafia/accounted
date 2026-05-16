# ── Stage 1: Base ──
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat

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

# Apply extension preset (must happen before build — prebuild hook
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
FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache curl

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone output
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy entrypoint script
COPY --chmod=755 docker-entrypoint.sh ./docker-entrypoint.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
