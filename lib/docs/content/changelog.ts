import { API_V1_VERSION } from '@/lib/api/v1/version'

export const CHANGELOG_MD = `# Changelog

> Reverse-chronological release notes for the Accounted REST API. Versions follow Stripe's dated format (\`YYYY-MM-DD\`). The current version is **\`${API_V1_VERSION}\`**.

---

## ${API_V1_VERSION} *(current)*

The first stable release of the public REST API. Six phases of development covering the full agent-native surface: authentication + discovery, invoicing vertical, transactions vertical, bookkeeping engine + suppliers + compliance check, payroll + reports + import, webhooks.

### Authentication + discovery (Phase 1)

- API key auth via \`Authorization: Bearer gnubok_sk_<random>\` (live keys) / \`gnubok_sk_test_<random>\` (test keys). 100 RPM rate limit per key.
- \`gnubok_sk_test_*\` keys bound to deterministic sandbox companies.
- Scope-based authorisation per endpoint (\`invoices:read\`, \`payroll:write\`, \`webhooks:manage\`, ...).
- Discovery: \`GET /llms.txt\`, \`GET /api/v1/openapi.json\`, \`GET /.well-known/skills/index.json\`.
- Health: \`GET /api/v1/health\`.
- Response envelope: \`{ data, meta: { request_id, api_version, audit, next_cursor } }\`.
- \`X-Request-Id\` on every response; idempotency on every write.

### Invoices vertical (Phase 2)

- **Customers**: GET list + detail, POST create + bulk-create, PATCH, DELETE.
- **Invoices**: GET list + detail, POST create, PATCH, lifecycle verbs \`/mark-sent\`, \`/mark-paid\`, \`/credit\`, \`/send\`, \`/bulk-create\`. PDF download at \`/{id}/pdf\`.
- VIES validation runs on commit for EU-business customers with a VAT number.
- Mixed-rate invoices supported: per-item \`vat_rate\` overrides the header rate.
- ROT/RUT-avdrag flow and supplier-invoice fakturamodellen on the AP side.

### Transactions vertical (Phase 3)

- **Transactions**: cursor-paginated GET list + detail. Single-tx verbs \`/categorize\`, \`/uncategorize\`, \`/match-invoice\`, \`/match-supplier-invoice\`. Bulk \`/ingest\` (up to 500), \`/batch-categorize\` (up to 100).
- **Reconciliation**: \`POST /reconciliation/bank/run\`, \`GET /reconciliation/bank/status\`.
- **Reads**: \`GET /accounts\`, \`GET /fiscal-periods\`.
- All write surfaces honour strict-mode (commit fully or error with no side effects).

### Bookkeeping primitives + AP + compliance (Phase 4)

- **Suppliers + supplier-invoices** vertical (mirror of Phase 2 invoices on the AP side).
- **Journal entries** primitives: \`POST /journal-entries\` (draft+commit), \`/{id}/commit\`, \`/{id}/reverse\` (storno) and \`/{id}/correct\` (rättelse): both satisfy BFL 5 kap 5 § (storno is the canonical method of rättelse), \`/batch-create\`.
- **Voucher gap explanations**: \`POST /voucher-gap-explanations\` per BFNAR 2013:2.
- **Fiscal-periods ops**: \`/lock\`, \`/close\` and \`/opening-balances\` are synchronous and return 200 with the updated period; \`/year-end\` and \`/currency-revaluation\` are async and return 202 with operation_id (poll at \`GET /api/v1/operations/{id}\`).
- **Compliance check**: \`GET /compliance/check?type={year_end_readiness|voucher_gaps}\`: pre-flight findings before submission.
- **Documents**: \`POST /documents\` (multipart upload, magic-number-checked), \`GET /{id}/download\` (15-min signed URL), \`POST /{id}/link\` (attach to journal entry).

### Payroll + reports + import (Phase 5)

- **Employees**: full CRUD with personnummer masking on list/create per GDPR Art.5(1)(c). Soft-delete via \`is_active\`.
- **Salary runs**: CRUD + lifecycle verbs \`/calculate\`, \`/approve\`, \`/mark-paid\`, \`/book\`, \`/generate-agi\`. State machine: draft → review → approved → paid → booked. \`/generate-agi\` produces and persists the arbetsgivardeklaration XML: the response carries it as \`data.xml\` for the integrator to upload to Skatteverket Mina Sidor (or via the optional \`skatteverket\` extension). Accounted does NOT auto-submit; the AGI deadline: **the 12th of the following month for every reporting period EXCEPT January and August, where companies with annual turnover ≤ 40 MSEK get the 17th**: is the integrator's responsibility.
- **JSON reports** (13): trial-balance, balance-sheet, income-statement, general-ledger, journal-register, vat-declaration, monthly-breakdown, ar-ledger, supplier-ledger, continuity-check, salary-journal, avgifter-basis, vacation-liability.
- **Binary report**: \`GET /reports/sie-export\` (text/plain SIE4 file). Note: a SIE4 export alone does NOT satisfy BFL 7 kap archiving obligations: SIE captures account-level positions and verifikationer but lacks system documentation and behandlingshistorik. Treat SIE as a portability format (Fortnox/Visma/Bokio migration), not as a complete archive.
- **Async imports**: \`POST /imports/sie\` (multipart, 50 MB), \`POST /imports/bank\` (multipart, 10 MB, auto-format detection across 12 bank formats). Both async via \`operations\` substrate. **Post-SIE-import warning:** SIE files do NOT carry VAT codes or tax-rate-to-account mappings, AND they do NOT transfer behandlingshistorik (the source system's processing log required by BFNAR 2013:2 kap 8 §) or systemdokumentation. After importing from Fortnox / Visma / BL / SpeedLedger / Bokio you MUST manually reconfigure VAT codes (typically via \`/settings/tax-codes\`) before the first momsdeklaration; skipping this step is the most common source of incorrect VAT submissions in migrated bookkeeping. The behandlingshistorik gap must be preserved separately: under BFNAR 2013:2 kap 8 § the obligation attaches to the entire räkenskapsår, not from the import date forward. Best practice for a mid-year migration: export the source system's behandlingshistorik for the full fiscal year and archive it alongside the SIE file. Accounted starts a fresh behandlingshistorik from the import date forward; the pre-import portion of the year remains the source system's record.

### 2026-05-15 — Webhooks (Phase 6 PR-1)

- **Subscriptions**: \`POST /webhooks\` (HMAC secret returned exactly once), GET list + detail, PATCH, DELETE. Per-event-type elevated scope check (\`salary_run.*\` and \`agi.generated\` require \`payroll:read\`).
- **Delivery substrate**: per-minute Vercel cron at \`/api/webhooks/dispatch/cron\`. Due rows are claimed atomically via the \`claim_due_webhook_deliveries\` SQL function (\`FOR UPDATE SKIP LOCKED\`), with \`*.pg.test.ts\` coverage for the claim path and the webhook DB triggers. Exponential backoff \`1m / 5m / 30m / 2h / 12h / 24h / 48h\` (7 retries, ~87h total). HTTP 410 from receiver auto-disables the webhook.
- **Signature**: \`X-Gnubok-Signature: t=<unix>,v1=<hex-HMAC-SHA256>\`. Stripe-format. Sample receivers in [Node + Python](/docs/api/webhooks#verifying-signatures).
- **SSRF protection**: webhook_url must be HTTPS; resolved IPs in private/loopback/link-local/CGNAT/cloud-metadata ranges are rejected at create AND dispatch time. Dispatch pins the validated IP through a DNS-rebinding-safe \`node:https.request\` agent (\`lib/webhooks/pinned-fetch.ts\`); redirects are refused on every outbound POST (any 3xx is treated as a blocked redirect).
- **Audit + retention**: webhook delivery rows are *behandlingshistorik* per BFNAR 2013:2 kap 8 §: immutable once terminal so the audit trail of what an integration was notified of stays intact. Delivery rows are NOT räkenskapsinformation themselves; the 7-year statutory retention under BFL 7 kap 1 § applies only to the underlying verifikation / faktura / AGI XML in its own table, NOT to the delivery envelope. Accounted keeps accounting-event delivery rows for 7 years as a voluntary operational policy (the duration aligns with BFL 7 kap on the underlying records but is not itself a statutory obligation on delivery rows). Webhook DELETE preserves the delivery audit trail (\`ON DELETE SET NULL\` on \`webhook_id\`). Webhook lifecycle events (create / update / delete, plus dispatcher auto-disable) each write a V16 \`audit_log\` entry.
- **Verbs**: \`POST /webhooks/{id}/test\` enqueues a synthetic event; \`POST /webhook-deliveries/{id}/retry\` re-enqueues a dead/delivered delivery.

### Coming soon (Phase 6 PR-2 hardening)

- 90-day TTL cleanup cron for non-accounting webhook deliveries
- Per-route rate limits on \`:test\`, \`:retry\`, and webhook \`:create\`
- Populated \`previous_attributes\` for update-style webhook events
`
