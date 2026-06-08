import { API_V1_VERSION } from '@/lib/api/v1/version'

export const LANDING_MD = `# accounted API

> Swedish double-entry bookkeeping as a public REST API for agents and integrations. API version \`${API_V1_VERSION}\`.

The accounted API lets you do anything the dashboard can do — create invoices, ingest bank transactions, file VAT declarations, run payroll, and subscribe to webhooks for state changes. Every endpoint is designed for autonomous agents first: machine-readable schemas, dry-run previews, idempotent retries, and inline audit blocks on every write.

If you've used [Stripe's API](https://docs.stripe.com/api), the shape will feel familiar — bearer-token auth, dated API versions, webhook signature verification, idempotency keys. The accounting concepts are Swedish (BAS chart, BFL retention, K2/K3, momsdeklaration) but the surface is built for the same kind of integrator.

## Authentication

All requests authenticate with a bearer token in the \`Authorization\` header:

\`\`\`bash
curl https://app.gnubok.se/api/v1/companies \\
  -H "Authorization: Bearer gnubok_sk_live_..."
\`\`\`

Create keys in the accounted dashboard at **/settings/api**. Two key prefixes are available:

- \`gnubok_sk_live_*\` — hits real customer data. Use in production.
- \`gnubok_sk_test_*\` — bound to deterministic sandbox companies. Safe for evals, demos, and agent learning. Same surface, different blast radius.

Each key carries one or more **scopes** (\`invoices:read\`, \`invoices:write\`, \`payroll:write\`, \`webhooks:manage\`, ...) that gate which endpoints it can call. Scopes are listed on every endpoint reference page.

Rate limit: 100 requests per minute per key, returned in \`X-RateLimit-*\` headers.

## Base URL

\`\`\`
https://app.gnubok.se/api/v1
\`\`\`

URLs include the company id explicitly:

\`\`\`
GET  /api/v1/companies/{companyId}/invoices
POST /api/v1/companies/{companyId}/invoices
\`\`\`

A multi-company key can act on any company the underlying user is a member of — the URL is the source of truth, not a default. List the companies a key can access with:

\`\`\`bash
curl https://app.gnubok.se/api/v1/companies \\
  -H "Authorization: Bearer gnubok_sk_live_..."
\`\`\`

## Core principles

These four invariants hold across the entire surface — once you've internalised them you can predict the shape of any endpoint without reading the reference.

**Dry-run on every write.** Append \`?dry_run=true\` (or send \`X-Dry-Run: true\`) to any POST/PATCH/DELETE to preview the effect — the response shows the journal lines, voucher number, account deltas, and any validation errors that would surface, but commits nothing. Use this in agent test-loops to validate inputs before paying the side-effect cost.

**Idempotency-Key on every write.** Pass a UUID in the \`Idempotency-Key\` header. Replays of the same key+body return the original response with \`Idempotent-Replayed: true\` (24h cache). Replays with a different body return \`409 IDEMPOTENCY_KEY_REUSE\`.

**Strict-mode write semantics.** A v1 mutation either commits fully or returns a structured error code with no side effects. The dashboard soft-fails on partial writes (a human is there to retry); the v1 surface aborts. This means you never see "the invoice was sent but the email failed" — either both happened or neither did.

**Inline audit on every write.** Every successful write response includes an \`audit\` block in \`meta\` with the voucher number, audit-trail URL, and immutability timestamp. No second round-trip needed to confirm what happened.

## Response envelope

Every response has the same shape:

\`\`\`json
{
  "data": { ... },
  "meta": {
    "request_id": "req_...",
    "api_version": "${API_V1_VERSION}",
    "next_cursor": "...",
    "audit": { "voucher_number": "A-2026-042", "voucher_url": "..." }
  }
}
\`\`\`

Errors swap \`data\` for \`error\`:

\`\`\`json
{
  "error": {
    "code": "PERIOD_LOCKED",
    "message": "Den valda perioden är låst.",
    "message_en": "The selected period is locked.",
    "remediation": { "description": "Unlock via /fiscal-periods/{id}/unlock or pick an open period.", "tool": "fiscal_periods.unlock" },
    "details": { "fiscal_period_id": "..." },
    "docs_url": "https://app.gnubok.se/docs/api/errors#period_locked"
  },
  "meta": { "request_id": "req_...", "api_version": "${API_V1_VERSION}" }
}
\`\`\`

Every error code is documented in the [error reference](/docs/api/errors).

## Where to go next

- **[Quickstart cookbook](/docs/api/cookbook/quickstart)** — send your first invoice in five minutes.
- **[API reference](/docs/api/reference)** — every endpoint, grouped by resource.
- **[Webhooks](/docs/api/webhooks)** — subscribe to events with HMAC-signed delivery.
- **[Errors](/docs/api/errors)** — every stable error code with remediation.
- **[Versioning](/docs/api/versioning)** — how API versions are pinned and upgraded.
- **[Changelog](/docs/api/changelog)** — what shipped when.

For LLM-based agents:
- **[\`/llms.txt\`](/llms.txt)** — concise agent-discovery index.
- **[\`/llms-full.txt\`](/llms-full.txt)** — full docs concatenated for ingestion.
- **[\`/api/v1/openapi.json\`](/api/v1/openapi.json)** — machine-readable OpenAPI 3.1 spec.
- **[\`/.well-known/skills/index.json\`](/.well-known/skills/index.json)** — accounted-specific skill catalogue.
`
