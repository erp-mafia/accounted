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

- `/api/bookkeeping/*`: accounts, fiscal periods, journal entries (CRUD/reverse/correct), mapping rules, voucher gaps
- `/api/invoices/*`, `/api/supplier-invoices/*`: CRUD + state transitions
- `/api/transactions/*`: categorize, describe, book, match-{invoice,supplier-invoice}, batch, AI suggestions
- `/api/customers/*`, `/api/suppliers/*`: CRUD
- `/api/documents/*`: CRUD, versions, link, match-sweep, verify cron
- `/api/reports/*`: report endpoints (GL, TB, BS, IS, AR/supplier ledger, VAT, SIE, INK2, NE-bilaga, KPI, audit, continuity, monthly, full-archive, salary, vacation, avgifter)
- `/api/salary/*`: employees, payroll-config, tax-tables, KU, runs
- `/api/import/*`: bank-file, SIE (parse/execute/mappings)
- `/api/reconciliation/bank/*`, `/api/settings/*`, `/api/company/*`, `/api/team/*`
- `/api/deadlines/*`, `/api/tax-deadlines/*`: CRUD + crons
- `/api/pending-operations/*`, `/api/events/*`, `/api/audit-trail/*`
- `/api/calendar/feed/[token]`, `/api/mcp-oauth/*`, `/api/support/contact`, `/api/account/delete`
- `/api/log`, `/api/health`, `/api/vat/validate`, `/api/currency/rate`, `/api/sandbox/*`
- `/api/extensions/ext/[...path]`: dynamic extension routes (catch-all → `/api/extensions/ext/{extensionId}/{routePath}`, path params as `_paramName` query)
