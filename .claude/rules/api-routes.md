---
paths:
  - "src/app/api/**"
---

# API Route Pattern

**Default: wrap every cookie-session route in `withRouteContext`** (`lib/api/with-route-context.ts`). It is the only path that enforces MFA (AAL2) on hosted: it calls `requireAuth()`, resolves the active `companyId`, optionally gates non-viewer role (`requireWrite: true`), and converts thrown errors into the canonical envelope. **Never hand-roll `supabase.auth.getUser()` in a route**: that skips MFA. CI enforces this via the ratchet guard (`npm run check:guards`); a new route calling `getUser()` directly fails the build.

```typescript
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { MySchema } from '@/lib/api/schemas'

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

- Writing a table whose RLS write policy is `user_is_company_admin(...)` (`company_settings`, `companies`, `company_members`, `company_invitations`, `api_keys`, `invoice_payee_defaults`)? Gate with `{ requireAdmin: true }`, not `requireWrite`. A `member` passes `requireWrite`, and RLS then refuses silently: the UPDATE matches zero rows with no error, which `.single()` turns into a 500. `requireAdmin` asks the database that same predicate, so the route and the policy cannot disagree; the contract is pinned in `tests/pg/company-settings-admin-gate.pg.test.ts`. Columns of `company_settings` go through `writeCompanySettings` (`lib/company/settings-writer.ts`), on every door: it asks the role, also on a service-role client where RLS does not apply, and answers a write that matched no row as a failure. A route that does anything irreversible around the write (a file in a bucket) writes the row first.
- Dynamic route params: `{ params }: { params: Promise<{ id: string }> }` (Next.js 16, params are async). With `withRouteContext`, pass that shape as the generic and destructure `params` from the 3rd handler arg.
- Response shapes: `{ data }` for success; failures are the canonical `{ error: { code, message, message_en?, requestId? } }` envelope (thrown errors → `errorResponse`). Don't hand-build `{ error: 'string' }`.
- Zod schemas in `lib/api/schemas.ts`: 100+ schemas with shared primitives (uuid, isoDate, accountNumber, nonNegativeAmount).
- Events: `await eventBus.emit(...)` (or the service that emits) before returning, so the handlers (event_log, webhooks, extensions) finish inside the request. A route initialises nothing itself: `src/instrumentation.ts` loads lib/init when the server boots, and emit and the registry getters (`await extensionRegistry.get(id)`, `await getEmailService()`, ...) wait for that load. Never import `@/lib/init` in a route, statically or dynamically: `npm run check:guards` (static-init-import) fails it.
- Opt out of `withRouteContext` only when the route genuinely can't guarantee a company context (e.g. onboarding): then call `requireAuth()` directly so MFA is still enforced.
- API-key auth (`/api/v1/*`) uses `createServiceClientNoCookies()` + `v1ErrorResponse`; every query still filters by `company_id`.
- Journal entries a route creates: when the entry IS the accounting record (mark paid, mark sent under kontantmetoden, payout settle), a failed commit fails the request, otherwise AP/AR diverges from the ledger. When the entry is a side effect of the primary action (e.g. categorizing a transaction), log the failure with `log` and let the primary action succeed.

## New public capability: define an operation, don't hand-write doors

A capability a user can perform (create, update, delete, a lifecycle verb) that should be reachable by API is an **operation** (`src/lib/operations/`, contract in `types.ts`): one Zod input, one output, docs, scope, risk, and a `run(ctx, input, { dryRun })` that calls a service in `lib/`. From that single definition:
- v1: a route file is `export const POST = v1OperationHandler(op)` (registers the endpoint for openapi.json; `withApiV1` still does auth, scope, idempotency, test keys);
- MCP: an `mcp` binding generates the tool (search-only by default, zero tools/list cost); writes stage and approval runs the same `run()` through `commitPendingOperation`;
- dashboard: the session route calls the same service and maps failures with `sessionFailureResponse`.
- pinned previews, for free (`preview-token.ts`): every write's dry run answers a `preview_token`, and a commit or staging that sends it back is refused with 409 PREVIEW_STALE when the recomputed dry run differs. A dry run must therefore be deterministic for unchanged state: a preview value recomputed on every call (a timestamp defaulting to now) goes in the operation's `volatilePreviewKeys`, or every token is stale.
A write door of a switchable package (a route, v1 endpoint or operation under Lön, Kundfakturor, Kassa och webbshop, ...) needs a line in `src/lib/modules/package-doors.ts`: `start` if it creates a new root record (refused with `PACKAGE_OFF` while the package is off or winding down, by `withRouteContext`, `withApiV1`, the extension dispatcher, MCP and the commit path), else `continue`; `src/lib/modules/__tests__/package-doors.test.ts` names what is missing. Add the op to `OPERATIONS` in `registry.ts`, then follow `operation-contract.test.ts` failures (scope maps, risk tier, approval label in sv/en, op-type CHECK migration pair). `session-route-parity.test.ts` fails when a new dashboard write route has no API decision: add it to `SESSION_ROUTE_PARITY` as covered, gap or ui-only. Service-role doors skip RLS: an operation writing what the dashboard gates with `requireAdmin` must call `requireCompanyAdmin` (`lib/operations/access.ts`) in its service. The rules belong in the service, never in a door: two copies of one capability is how v1 came to drop fields the dashboard honoured (#3082).

## Endpoint map (`app/api/`)

Each directory under `app/api/` is a route family; list them with `find app/api -name route.ts | awk -F/ '{print $3}' | sort | uniq -c`. What the tree does not tell you:

- `/api/v1/*` is the public API-key REST surface (`withApiV1`, `lib/api/v1/`). Its `transactions/{id}/ignore` (POST/DELETE) books no verifikat: it is the locked-period escape hatch for non-business rows.
- `/api/extensions/ext/[...path]` is the catch-all for extension routes (`/api/extensions/ext/{extensionId}/{routePath}`, path params as `_paramName` query); the family also holds first-party callbacks (enable-banking, cloud-backup, invoice-inbox, whatsapp-inbox, shopify, woocommerce, stripe, skatteverket).
- `/api/reconciliation/accounts/[accountKey]/*` is the account-keyed engine (#1833); `/api/reconciliation/bank/*` holds the legacy verbs.
