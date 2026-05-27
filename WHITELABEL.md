# Whitelabel fork checklist

gnubok is whitelabel-friendly: every user-visible brand reference reads from a single `BrandingService` (`lib/branding/service.ts`). If you don't override anything, the app behaves exactly like upstream gnubok. To run your own brand on top of gnubok, fork the repo and override the values you care about.

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
| `NEXT_PUBLIC_BRANDING_APP_NAME` | `appName` | `Gnubok` |
| `NEXT_PUBLIC_BRANDING_APP_DESCRIPTION` | `appDescription` | `Ekonomihantering` |
| `BRANDING_LEGAL_ENTITY` | `legalEntity` | `Arcim` |
| `BRANDING_SUPPORT_EMAIL` | `supportEmail` | `support@gnubok.se` |
| `BRANDING_PRIVACY_EMAIL` | `privacyEmail` | `privacy@gnubok.se` |
| `BRANDING_SECURITY_EMAIL` | `securityEmail` | `security@arcim.io` |
| `NEXT_PUBLIC_BRANDING_AUTH_EMAIL_FROM` | `authEmailFrom` — From address Supabase Auth sends verification / reset emails from. Used to pre-populate the `from:` query on the "open in Gmail" button after signup. Set to whatever you configured in your Supabase Auth SMTP. | `noreply@gnubok.se` |
| `NEXT_PUBLIC_APP_URL` | `appUrl` | `https://app.gnubok.se` |
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
| `RESEND_API_KEY` | Resend API key — required for both outbound mail and the inbox webhook |
| `RESEND_FROM_EMAIL` | Default `From` address (e.g. `noreply@your-brand.se`); also used as the address you From-spoof through Resend |
| `RESEND_INBOUND_DOMAIN` | Domain used to compose per-company invoice-inbox addresses: `{local-part}@{RESEND_INBOUND_DOMAIN}` |
| `RESEND_INBOUND_WEBHOOK_SECRET` | Verifies the `/inbound` webhook signature from Resend |

## Things you MUST NOT change

These are stable contracts. Renaming them breaks existing data, sessions, or external clients (npm package consumers, MCP connectors, browser sessions, invite links). Leave them alone in your fork:

| Identifier | Where | Why |
|---|---|---|
| `gnubok-company-id` | cookie | Active company context — renaming breaks logged-in sessions |
| `gnubok-invite-token` | cookie | Pre-auth invite token holding — renaming drops in-flight invites |
| `gnubok_sk_` | API key prefix | All issued API keys; existing clients fail validation |
| `gnubok_inv_` | invite token prefix | All sent invite links break |
| `gnubok_*` | MCP tool names (`gnubok_list_invoices`, etc.) | Published MCP API — Claude clients have these cached |
| `gnubok-mcp` | npm package name | Whitelabel users still install `npx gnubok-mcp`. Document `GNUBOK_URL=https://app.your-brand.se/api/extensions/ext/mcp-server/mcp` so they hit your endpoint |
| `GNUBOK_API_KEY` | env var read by `gnubok-mcp` package | Same reason — npm consumer expects this name |

## What's outside this branding service

A few things that look brand-related but are configured elsewhere:

- **Supabase auth emails** (password reset, magic link) — set in the Supabase dashboard for your project, not in code.
- **Resend sending domain** — verify `noreply@your-brand.se` (or wherever) in Resend, set `RESEND_FROM_EMAIL`.
- **DNS / domain** — point `app.your-brand.se` at your Vercel deployment.
- **OAuth redirect allowlist for MCP** — `app/api/mcp-oauth/authorize/route.ts` lists `claude.ai/api/*`, `claude.com/api/*`, and localhost. Your domain is the OAuth issuer, not a redirect target — no change needed unless you're integrating with new MCP clients.
- **iCal feed PRODID** (`lib/calendar/ics-generator.ts`) — defaults to `erp-base.se`, callers may pass their domain.
- **`NEXT_PUBLIC_APP_URL`** — used as the OAuth issuer. Set this to your domain (e.g. `https://app.your-brand.se`).
- **Skatteverket submission identity** — `extensions/general/skatteverket/lib/api-client.ts` does not set a custom `User-Agent`; submissions go out with the Node/Vercel runtime default. If your deployment needs to identify itself to Skatteverket under a different brand, that's a future enhancement (env var + header), not something the current branding service covers.

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
            echo "Up to date with upstream — nothing to do."
            exit 0
          fi
          git push origin "${{ steps.merge.outputs.branch }}"
          gh pr create \
            --base main \
            --head "${{ steps.merge.outputs.branch }}" \
            --title "Sync from upstream gnubok" \
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

1. **Open an upstream issue** — the branding service is intentionally minimal; missing fields can be added.
2. **PR a hook upstream** — extending the service or adding a registry pattern keeps your fork clean.

## Verifying your whitelabel

After deploying:

- [ ] Visit `/` — browser tab title shows your brand.
- [ ] Visit `/login` and `/register` — your logo renders.
- [ ] View source of `/manifest.webmanifest` — `name`, `short_name`, `theme_color` reflect your overrides.
- [ ] Trigger an invite email — From line says `<your-brand> <noreply@...>`, body uses your name.
- [ ] Visit `/dpa` and `/privacy` — legal entity and contact email are yours.
- [ ] Open OAuth flow (`/api/mcp-oauth/authorize?...`) from a test MCP client — consent page references your brand.
- [ ] Submit support form (Settings → Support) — internal subject prefix is `[<your-brand> support]`.
