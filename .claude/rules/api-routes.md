---
paths:
  - "app/api/**"
---

# API Route Pattern

Use the `/erp-api-route` skill when scaffolding new endpoints.

**Default: wrap every cookie-session route in `withRouteContext`** (`lib/api/with-route-context.ts`). It is the only path that enforces MFA (AAL2) on hosted: it calls `requireAuth()`, resolves the active `companyId`, optionally gates non-viewer role (`requireWrite: true`), and converts thrown errors into the canonical envelope. **Never hand-roll `supabase.auth.getUser()` in a route**: that skips MFA. CI enforces this via the ratchet guard (`npm run check:guards`); a new route calling `getUser()` directly fails the build.

```typescript
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { MySchema } from '@/lib/api/schemas'

ensureInitialized()  // Module-level: loads extensions for event emission

// Dynamic route: pass the params type as the generic.
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'resource.action',
  async (request, { supabase, companyId, user, log }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, MySchema)
    if (!validation.success) return validation.response

    // Business logic... always filter by company_id (defense in depth alongside RLS).
    // Throw typed domain errors (e.g. lib/bookkeeping/errors): the wrapper maps
    // them to the right status + canonical { error: { code, message, message_en } }.
    return NextResponse.json({ data: result })
  },
  { requireWrite: true }, // omit for read-only routes
)
```

- Dynamic route params: `{ params }: { params: Promise<{ id: string }> }` (Next.js 16, params are async). With `withRouteContext`, pass that shape as the generic and destructure `params` from the 3rd handler arg.
- Response shapes: `{ data }` for success; failures are the canonical `{ error: { code, message, message_en?, requestId? } }` envelope (thrown errors → `errorResponse`). Don't hand-build `{ error: 'string' }`.
- Zod schemas in `lib/api/schemas.ts`: 100+ schemas with shared primitives (uuid, isoDate, accountNumber, nonNegativeAmount).
- Routes that emit events must call `ensureInitialized()` at module level.
- Opt out of `withRouteContext` only when the route genuinely can't guarantee a company context (e.g. onboarding): then call `requireAuth()` directly so MFA is still enforced.
- API-key auth (`/api/v1/*`) uses `createServiceClientNoCookies()` + `v1ErrorResponse`; every query still filters by `company_id`.

## Endpoint map (`app/api/`)

560 `route.ts` files under 55 top-level families (2026-08-26). Counts in parentheses; regenerate with `find app/api -name route.ts | awk -F/ '{print $3}' | sort | uniq -c`.

- `/api/v1/*` (110): the public API-key REST surface (`withApiV1`, `lib/api/v1/`). Companies (list + create), customers, invoices, suppliers, supplier-invoices, transactions, journal-entries, fiscal-periods, accounts, articles, documents, dimensions, employees, salary-runs, reports (16, incl. balance-sheet/income-statement PDFs), reconciliation (11, account-keyed), imports, operations, compliance, skatteverket/vat-declarations, settings, inbox-items, voucher-gap-explanations, webhooks, webhook-deliveries, openapi.json, health
- `/api/bookkeeping/*` (64): accounts, account-balances, account-totals, fiscal-periods, journal-entries (CRUD/reverse/correct), journal-entry-lines, mapping-rules, accruals, voucher-gaps, voucher-sequences, no-doc-required, fix-cash-mismatch
- `/api/reports/*` (58): GL, TB, BS/IS (+ balansrapport/resultatrapport), AR/supplier ledger, VAT, periodisk sammanställning, SIE, INK2, NE-bilaga, KPI, audit-trail, behandlingshistorik, bokslutsbilagor, continuity, monthly, dimension-pnl, kassaflödesanalys, statement-reconciliation, full-archive, salary-journal, vacation-liability, avgifter-basis
- `/api/salary/*` (36): employees, payroll-config, tax-tables, KU, runs, vacation-balances, vacation-year-close
- `/api/invoices/*` (28), `/api/supplier-invoices/*` (16): CRUD + state transitions, bulk-book, recurring, reminders, self-billed, preview-pdf, next-number; supplier side adds exists + payment-batches (betalfil)
- `/api/import/*` (26): bank-file, SIE (parse/execute/mappings), skattekonto-file, opening-balance, articles, customers, suppliers, documents
- `/api/extensions/*` (21): `ext/[...path]` dynamic extension routes (catch-all → `/api/extensions/ext/{extensionId}/{routePath}`, path params as `_paramName` query), `[sector]` listing, plus first-party callbacks (enable-banking, cloud-backup, invoice-inbox, whatsapp-inbox, shopify, woocommerce, stripe, skatteverket, push-notifications)
- `/api/transactions/*` (20): list/detail, categorize/uncategorize, book, ignore, match-{invoice,supplier-invoice} (+ preview), match-batch, batch-match-invoices, bulk-book, create-from-document, suggest-categories, attach-document, link-journal-entry, cash-account, duplicate-payment-check, refresh-exchange-rate
- `/api/settings/*` (19): company settings, api-keys, oauth-clients, booking-templates, counterparty-templates, logo, invoice-font, peppol, signals (eu-trade, ku, rot-rut)
- `/api/reconciliation/*` (18): `accounts` + `accounts/[accountKey]/*` (account-keyed engine, #1833: bridge, items + ignore, links, attachments, residual, signoff + reopen) and the legacy `bank/*` verbs (run, status, link/unlink, unmatched-entries, confirm-suggestions, mark-opening-balance)
- `/api/agent/*` (16): ask, invoke, composer, conversations (+ reject-pending), categorize (+ outcome), memory, knowledge, skills, profile (+ verify), feedback, onboarding/stream
- `/api/documents/*` (12): CRUD, versions, inline, link/detach, integrity, extraction-status, verify (+ cron), counts, inbox-available
- `/api/company/*` (10), `/api/team/*` (5), `/api/user/*` (4), `/api/account/*` (2): company CRUD, current, members + invites, check-org-number, migration-reset; team invite/accept/members; preferences, profile, locale, ui-state; delete, password
- `/api/dimensions/*` (9): CRUD, rules, tagging, import-existing
- `/api/pending-operations/*` (7): list/detail, bulk-commit, bulk-reject, expire
- `/api/mileage/*` (6), `/api/rot-rut/*` (6), `/api/webshop-orders/*` (6): trips, distance, book, export, salary-push; eligible, beslut, payout-requests, payout-file; orders + bulk-book + settings
- `/api/deadlines/*` (5), `/api/tax-deadlines/*` (2), `/api/tax-assessment-notices/*` (2), `/api/skatteverket/*` (3): deadline CRUD + status, tax-deadline generate + cron, assessment notices, skattekonto tax-payments
- `/api/customers/*` (3, incl. `[id]/personal-number`), `/api/suppliers/*` (2), `/api/articles/*` (2), `/api/assets/*` (3), `/api/cash-accounts`, `/api/export/*` (3: articles, customers, suppliers)
- `/api/billing/*` (3: checkout, portal, status), `/api/stripe/webhook`
- `/api/peppol/*` (2: inbound, outbound), `/api/webhooks/*` (2: dispatch cron, peppol/qvalia callback)
- `/api/receipt-hunt/*` (2: run, cron), `/api/sandbox/*` (2: seed, cleanup), `/api/events/*` (2), `/api/notices/*` (2), `/api/idempotency/cleanup/cron`
- `/api/mcp-oauth/*` (3: authorize, token, register), `/api/calendar/feed/[token]`, `/api/payslip/[token]/pdf`, `/api/storage/[...path]`
- Singletons: `/api/audit-trail`, `/api/auth/heartbeat`, `/api/currency/rate`, `/api/health`, `/api/kpi/preferences`, `/api/log`, `/api/onboarding/state`, `/api/support/contact`, `/api/vat/validate`, `/api/version`, `/api/worklist/counts`
