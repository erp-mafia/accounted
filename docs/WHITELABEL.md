# Whitelabel fork checklist

Accounted is whitelabel-friendly: every user-visible brand reference reads from a single `BrandingService` (`lib/branding/service.ts`). If you don't override anything, the app behaves exactly like upstream gnubok. To run your own brand on top of Accounted, fork the repo and override the values you care about.

## Quick start

```bash
# 1. Fork erp-mafia/gnubok on GitHub → you/your-brand
# 2. Clone and add upstream remote (one-time)
git clone https://github.com/you/your-brand
cd your-brand
git remote add upstream https://github.com/erp-mafia/gnubok

# 3. Copy the example branding extension
cp -r extensions/general/_example-branding extensions/general/your-brand
# Edit extensions/general/your-brand/index.ts with your brand values

# 4. (Optional) Set env vars instead of / in addition to the extension. See "Env vars" below.

# 5. Enable the extension
# Edit extensions.config.json and add "your-brand" to the array.

# 6. Run locally
npm run setup:extensions
npm run dev

# 7. Deploy to your hosting (Vercel, Docker, etc.)
```

## Env vars

All branding can be set via env vars. Public ones use `NEXT_PUBLIC_BRANDING_*` (build-time inlined, available in client components). Server-only ones use `BRANDING_*`.

| Env var | Field | Default |
|---|---|---|
| `NEXT_PUBLIC_BRANDING_APP_NAME` | `appName` | `Accounted` |
| `NEXT_PUBLIC_BRANDING_APP_DESCRIPTION` | `appDescription` | `Ekonomihantering` |
| `BRANDING_LEGAL_ENTITY` | `legalEntity` | `Arcim` |
| `BRANDING_SUPPORT_EMAIL` | `supportEmail` | `support@gnubok.se` |
| `BRANDING_PRIVACY_EMAIL` | `privacyEmail` | `privacy@gnubok.se` |
| `BRANDING_SECURITY_EMAIL` | `securityEmail` | `security@arcim.io` |
| `NEXT_PUBLIC_BRANDING_AUTH_EMAIL_FROM` | `authEmailFrom`: From address Supabase Auth sends verification / reset emails from. Used to pre-populate the `from:` query on the "open in Gmail" button after signup. Set to whatever you configured in your Supabase Auth SMTP. | `noreply@gnubok.se` |
| `NEXT_PUBLIC_APP_URL` | `appUrl` | `https://app.gnubok.se` |
| `NEXT_PUBLIC_WHITELABEL_DOMAINS` | Exact comma-separated hostnames served by the same hosted deployment. No wildcards. Invite and auth redirects use a listed host and otherwise fall back to `NEXT_PUBLIC_APP_URL`. | `` |
| `NEXT_PUBLIC_BRANDING_LOGO_PATH` | `logoPath` | `/gnubokiceon-removebg-preview.png` |
| `NEXT_PUBLIC_BRANDING_FAVICON_PATH` | `faviconPath` | `/favicon.ico` |
| `NEXT_PUBLIC_BRANDING_APPLE_ICON_PATH` | `appleTouchIconPath` | `/icons/icon-192.png` |
| `NEXT_PUBLIC_BRANDING_PWA_ICON_BASE` | `pwaIconBasePath` | `/icons` |
| `NEXT_PUBLIC_BRANDING_THEME_COLOR` | `themeColor` | `#304D83` |
| `NEXT_PUBLIC_BRANDING_MANIFEST_THEME_COLOR` | `manifestThemeColor` | `#1a1a1a` |
| `NEXT_PUBLIC_BRANDING_MANIFEST_BG_COLOR` | `manifestBackgroundColor` | `#ffffff` |
| `NEXT_PUBLIC_BRANDING_HIDDEN_NAV` | `hiddenNavHrefs` (comma-separated, e.g. `/salary,/customers`) | `` (none hidden) |

Resolution order (last wins): **defaults → env vars → extension override**.

`NEXT_PUBLIC_*` env vars are inlined at build time. Changing them requires a fresh `npm run build` to propagate.

`NEXT_PUBLIC_BRANDING_APP_NAME` also stamps the service worker push-notification fallback title in `public/sw.js`. This happens at build time for Vercel/local builds (via `scripts/inject-public-branding.mjs`, run from `prebuild`) and at container start for Docker (via `docker-entrypoint.sh`).

### Email / Resend (when `email` or `invoice-inbox` extensions are enabled)

| Env var | Purpose |
|---|---|
| `RESEND_API_KEY` | Resend API key: required for both outbound mail and the inbox webhook |
| `RESEND_FROM_EMAIL` | Default `From` address (e.g. `noreply@your-brand.se`); also used as the address you From-spoof through Resend |
| `RESEND_INBOUND_DOMAIN` | Domain used to compose per-company invoice-inbox addresses: `{local-part}@{RESEND_INBOUND_DOMAIN}` |
| `RESEND_INBOUND_WEBHOOK_SECRET` | Verifies the `/inbound` webhook signature from Resend |
| `RESEND_DELIVERY_WEBHOOK_SECRET` | Verifies the `/delivery-status` webhook signature from Resend. Optional: without it, invoice delivery history shows "sent" but never the delivery outcome |

### WhatsApp (when the `whatsapp-inbox` extension is enabled)

| Env var | Purpose |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Meta system-user permanent token (`whatsapp_business_messaging` scope only) |
| `WHATSAPP_PHONE_NUMBER_ID` | Graph object id of your WhatsApp Business number |
| `WHATSAPP_APP_SECRET` | Verifies `X-Hub-Signature-256` on the `/webhook` POST |
| `WHATSAPP_VERIFY_TOKEN` | Shared secret for the GET subscription handshake (also entered in the Meta app dashboard) |
| `WHATSAPP_PHONE_HASH_KEY` | Random pepper for phone lookup hashes (`openssl rand -hex 32`) |
| `WHATSAPP_PHONE_ENCRYPTION_KEY` | 32-byte hex AES-256-GCM key for phone numbers at rest (`openssl rand -hex 32`) |
| `WHATSAPP_PUBLIC_NUMBER` | Optional: the public number as E.164 digits (e.g. `46766867041`) for the wa.me deep link in settings; unset = resolved from the Graph API |

## Things you MUST NOT change

These are stable contracts. Renaming them breaks existing data, sessions, or external clients (npm package consumers, MCP connectors, browser sessions, invite links). Leave them alone in your fork:

| Identifier | Where | Why |
|---|---|---|
| `gnubok-company-id` | cookie | Active company context: renaming breaks logged-in sessions |
| `gnubok-invite-token` | cookie | Pre-auth invite token holding: renaming drops in-flight invites |
| `gnubok_sk_` | API key prefix | All issued API keys; existing clients fail validation |
| `gnubok_inv_` | invite token prefix | All sent invite links break |
| `gnubok_*` | MCP tool names (`gnubok_list_invoices`, etc.) | Published MCP API: Claude clients have these cached |
| `gnubok-mcp` | npm package name | Whitelabel users still install `npx gnubok-mcp`. Document `GNUBOK_URL=https://app.your-brand.se/api/extensions/ext/mcp-server/mcp` so they hit your endpoint |
| `GNUBOK_API_KEY` | env var read by `gnubok-mcp` package | Same reason: npm consumer expects this name |

## What's outside this branding service

A few things that look brand-related but are configured elsewhere:

- **Supabase auth emails** (password reset, magic link): set in the Supabase dashboard for your project, not in code.
- **Resend sending domain**: verify `noreply@your-brand.se` (or wherever) in Resend, set `RESEND_FROM_EMAIL`.
- **DNS / domain**: point `app.your-brand.se` at your Vercel deployment.
- **OAuth redirect allowlist for MCP**: `lib/auth/oauth-allowlist.ts` has built-in entries for Claude (`claude.ai/api/*`, `claude.com/api/*`), ChatGPT, Grok, Cursor and localhost; anything else is registered per user under Settings > API & MCP > OAuth clients. Your domain is the OAuth issuer, not a redirect target: no change needed unless you're integrating with new MCP clients.
- **iCal feed PRODID** (`lib/calendar/ics-generator.ts`): defaults to `erp-base.se`, callers may pass their domain.
- **`NEXT_PUBLIC_APP_URL`**: used as the OAuth issuer and safe auth-link fallback. For a dedicated one-brand deployment, set this to your domain (e.g. `https://app.your-brand.se`). For a shared hosted deployment, keep the canonical main app URL here and register additional hosts through `NEXT_PUBLIC_WHITELABEL_DOMAINS`.
- **Skatteverket submission identity**: `extensions/general/skatteverket/lib/api-client.ts` does not set a custom `User-Agent`; submissions go out with the Node/Vercel runtime default. If your deployment needs to identify itself to Skatteverket under a different brand, that's a future enhancement (env var + header), not something the current branding service covers.

## Shared hosted deployment with custom domains

Use this checklist when several white-label domains point at one hosted Accounted deployment:

Accounted's hosted product serves its customers from the `accounted.se` zone: `app.accounted.se` plus one `<brand>.accounted.se` host per white-label byra. Every one of those hosts must be served by the production Supabase project `pwxtzglxptnnvjrpixpg`. The request proxy asserts that pairing instead of enumerating the hosts to protect: when the build answering a customer-facing production host is wired to any other backend (the staging project, a third project, or a URL it cannot parse), it emits an alerting structured error and returns an empty, non-cacheable `503` before session handling. The event records only the hostname and the `non_production` classification, never the configured backend URL or credentials.

Because the rule is stated as "this namespace belongs to the production project", a newly launched `<brand>.accounted.se` host is protected as soon as it resolves. There is no list to remember to update. The first version of the guard did the opposite: it enumerated seven approved hostnames, and on 2026-08-26 it failed open on `improveone.accounted.se`, a customer host nobody had added, which a feature-branch preview served from the staging project for hours. Vercel preview domains (`*.vercel.app`) and local development names stay out of scope. A host inside the namespace that is deliberately not production has to be excluded explicitly in `lib/domains/production-white-label-backend.ts`, in the same change that creates it.

Two kinds of host are not derivable from the namespace, so they are still classified by hand in `CUSTOMER_PRODUCTION_WHITE_LABEL_HOSTS` (`lib/domains/production-white-label-backend.ts`): Accounted's legacy canonical host `app.gnubok.se`, and a customer that brings its own domain (step 1 below). Add those as part of the same reviewed rollout. The set also still lists the `accounted.se` hosts the namespace rule already covers: there they are a checked-in inventory the tests pin host by host, not what makes those hosts protected. Do not derive the set from `NEXT_PUBLIC_WHITELABEL_DOMAINS`: that variable is an auth callback allowlist, not an authoritative production inventory, and it can also contain demo, pilot, or self-hosted domains.

The guard contains a misrouted deployment. It does not classify domains outside the hosted namespace, prove cross-tenant isolation, or replace the operational work of placing customer environments under production ownership and controls. Its `alert: true` flag also pages nobody on its own: middleware never registers the observability sink, so the alerting rule is configured on the hosting side and matches `operation=white_label_backend_guard` in the emitted log line.

1. Register the exact custom hostname on the hosting deployment and finish its DNS verification.
2. Add that hostname to the comma-separated `NEXT_PUBLIC_WHITELABEL_DOMAINS` value. Entries are exact hostnames such as `portal.partner.se`; wildcard entries are ignored.
3. Add `https://portal.partner.se/auth/callback` and `https://portal.partner.se/invite/*` to the Supabase Auth Redirect URLs allowlist. Keep the canonical `NEXT_PUBLIC_APP_URL` callback there too.
4. Redeploy after changing the environment variable. It is public build-time configuration because the browser must validate password-reset callbacks before calling GoTrue.
5. Test a new-user invitation, an existing-user invitation, and a password reset from the custom domain.

The request `Host` header and `window.location.origin` are inputs, not trust anchors. Accounted uses them only when the hostname exactly matches the canonical app host or a configured white-label hostname. Unknown or spoofed hosts fall back to `NEXT_PUBLIC_APP_URL`, so they cannot become invite links or GoTrue redirect targets.

## Staying in sync with upstream

Add this workflow at `.github/workflows/sync-upstream.yml` to your fork. It runs weekly and opens a PR with upstream changes:

```yaml
name: Sync from upstream

on:
  schedule:
    - cron: '0 3 * * 1'  # Mondays 03:00 UTC
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

      - name: Add upstream and fetch
        run: |
          git remote add upstream https://github.com/erp-mafia/gnubok
          git fetch upstream main

      - name: Create sync branch and merge
        id: merge
        run: |
          BRANCH="sync/upstream-$(date +%Y-%m-%d)"
          git checkout -b "$BRANCH"
          if git merge --no-edit upstream/main; then
            echo "status=clean" >> "$GITHUB_OUTPUT"
          else
            echo "status=conflict" >> "$GITHUB_OUTPUT"
            git merge --abort || true
          fi
          echo "branch=$BRANCH" >> "$GITHUB_OUTPUT"

      - name: Push and open PR (clean merge)
        if: steps.merge.outputs.status == 'clean'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          if git diff --quiet origin/main..HEAD; then
            echo "Up to date with upstream: nothing to do."
            exit 0
          fi
          git push origin "${{ steps.merge.outputs.branch }}"
          gh pr create \
            --base main \
            --head "${{ steps.merge.outputs.branch }}" \
            --title "Sync from upstream Accounted" \
            --body "Automated weekly sync from \`erp-mafia/gnubok@main\`."

      - name: Report conflict
        if: steps.merge.outputs.status == 'conflict'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh issue create \
            --title "Upstream sync conflict ($(date +%Y-%m-%d))" \
            --label sync-conflict \
            --body "Automated upstream merge hit a conflict. Resolve manually: \`git fetch upstream && git merge upstream/main\`."
```

## Conflict avoidance

The fork-friendliness of this design depends on you keeping changes confined to your branding extension folder. Every file you edit in `lib/`, `app/`, or `components/` becomes a potential conflict on the next upstream merge. If you find yourself wanting to override something the branding service doesn't expose, prefer:

1. **Open an upstream issue**: the branding service is intentionally minimal; missing fields can be added.
2. **PR a hook upstream**: extending the service or adding a registry pattern keeps your fork clean.

## Verifying your whitelabel

After deploying:

- [ ] Visit `/`: browser tab title shows your brand.
- [ ] Visit `/login` and `/register`: your logo renders.
- [ ] View source of `/manifest.webmanifest`: `name`, `short_name`, `theme_color` reflect your overrides.
- [ ] Trigger an invite email: From line says `<your-brand> <noreply@...>`, body uses your name.
- [ ] Visit `/dpa` and `/privacy`: legal entity and contact email are yours.
- [ ] Open OAuth flow (`/api/mcp-oauth/authorize?...`) from a test MCP client: consent page references your brand.
- [ ] Submit support form (Settings → Support): internal subject prefix is `[<your-brand> support]`.
