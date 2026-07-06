/**
 * /llms.txt: agent-discoverable index of the Accounted API.
 *
 * Convention adopted by Stripe, Anthropic, and other agent-facing platforms:
 * a plain-text Markdown file at the doc root that points LLM crawlers and
 * IDE agents (Cursor, Claude Code, Windsurf) at the canonical resources
 * they need. Cheaper than scraping HTML.
 */

import { NextResponse } from 'next/server'
import { API_V1_VERSION } from '@/lib/api/v1/version'
import { withPublicSecurityHeaders } from '@/lib/api/v1/security-headers'
import { getCanonicalBaseUrl } from '@/lib/api/v1/base-url'

export async function GET(_request: Request) {
  const base = getCanonicalBaseUrl()

  const body = `# Accounted API

> Swedish double-entry bookkeeping as a public REST API. API version ${API_V1_VERSION}.

This API lets agents and integrations do anything the Accounted dashboard can do:
read transactions, create invoices, mark them paid, run VAT reports, file year-end
declarations, ingest SIE files, and subscribe to webhooks for state changes.

## Quickstart

1. Create an API key in the Accounted dashboard at /settings/api.
2. Authenticate with \`Authorization: Bearer gnubok_sk_<live|test>_<random>\`.
3. List companies the key can access: \`GET ${base}/api/v1/companies\`.
4. Use the returned \`id\` as \`{companyId}\` in subsequent paths.

## Core principles

- **Dry-run on every write.** Add \`?dry_run=true\` or \`X-Dry-Run: true\` to any
  POST/PATCH/DELETE to preview the effect (journal lines, voucher number,
  account deltas) without committing. The same call without dry-run commits.
- **Idempotency-Key on every write.** Pass a UUID in \`Idempotency-Key\`; replays
  return the cached response (24h TTL) with \`Idempotent-Replayed: true\`.
- **Test mode.** Create a key with mode \`test\` (prefix \`gnubok_sk_test_\`) in the
  dashboard. A test key forces \`dry_run\` on every write against your real company:
  you get a realistic 200 + preview of what *would* happen, but nothing is ever
  saved or sent. Reads return real data; responses carry \`X-Gnubok-Mode: test\`.
  Writes on endpoints that can't be simulated are refused (403
  \`TEST_KEY_WRITE_BLOCKED\`). It's \`?dry_run=true\` baked into the credential, so
  you can develop safely before switching to a live key.
- **Compliance pre-flight.** \`GET /api/v1/companies/{id}/compliance/check?type=…\`
  returns structured findings (voucher gaps, locked-period violations, VAT close
  blockers, missing receipts) before you submit.

## Resources

- OpenAPI 3.1 spec: ${base}/api/v1/openapi.json
- Skills catalogue: ${base}/.well-known/skills/index.json
- Health check: ${base}/api/v1/health
- Docs (cookbook + reference): ${base}/docs/api
- Error reference: ${base}/docs/api/errors
- Security disclosure policy: ${base}/SECURITY.md (responsible disclosure to security@arcim.io)

## Schema discovery

Every \`.md\` URL under /docs/api is served as plain Markdown so agents can
ingest it without HTML parsing.

## Versioning

The URL major version is \`/api/v1/\`. Within v1, the response shape is pinned to
\`${API_V1_VERSION}\`. Future breaking changes inside v1 will accept an optional
\`Gnubok-Version: YYYY-MM-DD\` header for opt-in upgrades; older versions keep
working until explicitly retired.
`

  return new NextResponse(body, {
    status: 200,
    headers: withPublicSecurityHeaders({
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    }),
  })
}
