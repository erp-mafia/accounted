/**
 * The Accounted end-to-end environment.
 *
 * A production-shaped system in a microVM: the app's own production build, the
 * real self-hosted Supabase stack (Postgres + GoTrue + PostgREST + Storage +
 * Realtime) carrying every migration in supabase/migrations/, and a fake
 * Enable Banking answering at the bank API's real hostname.
 *
 * Three things are deliberately NOT softened for the tests:
 *
 * - **MFA stays on.** `NEXT_PUBLIC_REQUIRE_MFA=true`, as on hosted. Enrolling
 *   and verifying TOTP is part of what onboarding has to get right, so the
 *   suite computes the codes (spectest/lib/totp.ts) instead of switching the
 *   requirement off.
 * - **The extension preset is the hosted one.** docker/extensions.hosted.json,
 *   so enable-banking, tic, skatteverket and the rest are wired exactly as in
 *   production rather than the thinner self-hosted set.
 * - **The app is not told it is under test.** The Enable Banking fake answers
 *   at `api.enablebanking.com`, the address the client already calls, so no
 *   test-only base URL is threaded through the app.
 */
import { defineEnvironment, type Ctx } from "@specific.dev/spectest";
import { supabase } from "@specific.dev/spectest/components";
import { enableBankingFake } from "./fakes/enable-banking";
import { viesFake } from "./fakes/vies";
import { skatteverketFake } from "./fakes/skatteverket";
import { scbFake } from "./fakes/scb";

/**
 * The project's own supabase/ folder: config.toml (auth rules, MFA, password
 * policy) and every migration, applied in filename order, then seed.sql.
 *
 * seed.sql is what grants anon/authenticated/service_role the DML a hosted
 * project grants them; the upstream images do not, and without it every
 * PostgREST call fails with "permission denied". RLS is untouched.
 *
 * `hostname` puts the gateway on HTTPS, which is not cosmetic: the app is
 * served over TLS (see APP_URL below), and a page loaded over https that calls
 * a plain-http Supabase is mixed content. Chromium blocks it outright, so the
 * browser client fails before it reaches the network and the app reports a
 * generic auth error with nothing in the server log to explain it.
 */
const sb = supabase({ dir: "supabase", hostname: "supabase.test" });

/**
 * The app is served over TLS, at a hostname, because production is.
 *
 * next.config.ts sets `Strict-Transport-Security: max-age=63072000;
 * includeSubDomains; preload` on every response, so a browser that has seen
 * this app once refuses plain HTTP to it — driving it over http:// fails with
 * ERR_SSL_PROTOCOL_ERROR rather than loading. Serving it the way it is served
 * in production is both more faithful and the thing that makes HSTS a
 * non-issue. The daemon terminates TLS with a certificate from the in-VM CA
 * that Chromium trusts, and reverse-proxies plain HTTP to the container.
 */
export const APP_HOST = "app.test";
export const APP_URL = `https://${APP_HOST}`;

/**
 * The app's production build.
 *
 * NEXT_PUBLIC_* values are inlined by Next at build time, so they are baked in
 * here rather than passed as runtime env. They can be: the gateway address and
 * the API keys are fixed by the supabase() component (the keys derive from a
 * stable jwtSecret), so this string does not change between runs and the image
 * stays cached.
 *
 * The Enable Banking signing key is generated in the image instead of being
 * committed or passed in. lib/jwt.ts needs a real RSA key to sign with, a key
 * in the repo would trip secret scanners, and one generated per run in this
 * file would change the environment every run and force a cold rebuild. The
 * fake checks the token's shape, not its signature, so a per-image key is
 * exactly enough.
 */
const appDockerfile = `
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Same extension set as hosted, so enable-banking and friends are present.
COPY docker/extensions.hosted.json ./extensions.config.json

ENV NEXT_PUBLIC_SUPABASE_URL=${sb.url}
ENV NEXT_PUBLIC_SUPABASE_WS_URL=${sb.url.replace(/^http/, "ws")}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${sb.anonKey}
ENV NEXT_PUBLIC_APP_URL=${APP_URL}
ENV NEXT_PUBLIC_SELF_HOSTED=false
ENV NEXT_PUBLIC_REQUIRE_MFA=true
ENV NEXT_PUBLIC_BRANDING_APP_NAME=Accounted

# Not just for the runtime: ensureInitialized() runs at module scope in every
# route that emits events, and Next evaluates those modules while collecting
# page data. lib/init.ts throws on a missing core var unless
# NEXT_PUBLIC_SUPABASE_URL is a build sentinel, and it is a real URL here
# because the NEXT_PUBLIC_* values have to be inlined. So the core vars have
# to be present at build time too. Both are local throwaways.
ENV SUPABASE_SERVICE_ROLE_KEY=${sb.serviceRoleKey}
ENV CRON_SECRET=e2e-cron-secret

ENV NEXT_TELEMETRY_DISABLED=1
# The production build needs the same headroom it needs on Vercel.
ENV NODE_OPTIONS=--max-old-space-size=6144
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# A throwaway RSA key for the Enable Banking JWT, baked into the image so it is
# stable per build and absent from the repo.
RUN openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /app/eb-key.pem 2>/dev/null \\
 && base64 -w0 /app/eb-key.pem > /app/eb-key.b64 \\
 && rm /app/eb-key.pem

# A throwaway client certificate for SCB, same reasoning: lib/parties/scb
# needs a .pfx to be "configured" and to open its TLS connection; the fake
# never inspects it.
RUN openssl req -x509 -newkey rsa:2048 -nodes -keyout /app/scb-key.pem -out /app/scb-cert.pem -days 3650 -subj "/CN=e2e-scb" 2>/dev/null \\
 && openssl pkcs12 -export -inkey /app/scb-key.pem -in /app/scb-cert.pem -out /app/scb.pfx -passout pass:e2e-scb 2>/dev/null \\
 && base64 -w0 /app/scb.pfx > /app/scb-pfx.b64 \\
 && rm /app/scb-key.pem /app/scb-cert.pem /app/scb.pfx
`;

export const env = defineEnvironment({
  name: "accounted",

  // Declared here rather than on the project so ctx.fakes.enableBanking is
  // typed against the helper interface without a cast.
  fakes: {
    enableBanking: enableBankingFake,
    vies: viesFake,
    skatteverket: skatteverketFake,
    scb: scbFake,
  },

  services: {
    supabase: sb.group,

    app: {
      image: { type: "dockerfile", content: appDockerfile },
      // The signing key lives in a file in the image; export it before the
      // server starts so lib/jwt.ts finds it where it expects to.
      command:
        "export ENABLE_BANKING_PRIVATE_KEY=$(cat /app/eb-key.b64) SCB_API_CERT_PFX_BASE64=$(cat /app/scb-pfx.b64) && node server.js",
      env: {
        ...sb.appEnv,
        SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey,
        NEXT_PUBLIC_SUPABASE_URL: sb.url,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: sb.anonKey,
        NEXT_PUBLIC_APP_URL: APP_URL,
        NEXT_PUBLIC_REQUIRE_MFA: "true",
        NEXT_PUBLIC_SELF_HOSTED: "false",

        // Enable Banking. No base URL: the client's default is the fake's
        // hostname, which is the point.
        ENABLE_BANKING_APP_ID: "e2e-test-app-id",
        ENABLE_BANKING_PSU_TYPE: "business",

        // The image runs NODE_ENV=production, so lib/salary/personnummer.ts
        // refuses to fall back to its dev key. Without this, creating an
        // employee 500s.
        PERSONNUMMER_ENCRYPTION_KEY: "e2e-personnummer-key",

        // Skatteverket. No base URLs: the extension's clients already default
        // to the test environment, which is exactly where the fake answers.
        // Only the credentials are needed, and they are required rather than
        // optional: getClientId() and getApiGwClientId() throw without them.
        // Server-side feature flag, checked as the literal string "true" by
        // app/api/extensions/ext/[...path]/route.ts. Without it every
        // Skatteverket route answers 503 EXTENSION_DISABLED.
        SKATTEVERKET_ENABLED: "true",
        SKATTEVERKET_OAUTH2_CLIENT_ID: "e2e-skv-oauth-client",
        SKATTEVERKET_OAUTH2_CLIENT_SECRET: "e2e-skv-oauth-secret",
        SKATTEVERKET_APIGW_CLIENT_ID: "e2e-skv-apigw-client",
        SKATTEVERKET_APIGW_CLIENT_SECRET: "e2e-skv-apigw-secret",
        // Hashed to 32 bytes by token-store.ts, so any string works. The
        // tokens are stored encrypted at rest; without this the callback
        // exchanges the code and then throws before persisting.
        SKATTEVERKET_TOKEN_ENCRYPTION_KEY: "e2e-skv-token-key",

        // SCB's company register. No base URL: the client's default is the
        // fake's hostname. The certificate comes from the image (see the
        // Dockerfile); only its password is passed here.
        SCB_API_CERT_PASSWORD: "e2e-scb",

        CRON_SECRET: "e2e-cron-secret",
      },
      ports: [3000],
      tls: [{ hostname: APP_HOST, port: 3000 }],
      dependsOn: [sb.ready],
      readyCheck: { type: "http", port: 3000, path: "/api/health", timeoutSecs: 180 },
    },
  },
});

export type AppCtx = Ctx<typeof env>;

export default env.project();
