# CLAUDE.md: Accounted

Swedish accounting SaaS: double-entry bookkeeping under Swedish accounting law (Bokföringslagen) for sole traders (enskild firma) and limited companies (aktiebolag). Multi-tenant: users belong to companies via `company_members`; `teams` group companies for consultants.

**Stack**: Next.js 16 (App Router), React 19, TypeScript 5 strict, Zod 4, Supabase (Postgres + RLS + auth), Tailwind 4 + shadcn/ui. Vercel-hosted is the primary target; Docker self-hosted must keep working but never at hosted's expense. Path alias `@/*` = repo root. All code, comments, and commits in English.

---

## Hard Rules

The accounting rules are Swedish law, enforced by DB triggers. Code that violates them fails at runtime; code that works around the triggers breaks legal compliance. Never do either.

1. **Never edit or delete a posted journal entry.** Committed vouchers are immutable. Cancel with `reverseEntry()`; correct with `correctEntry()` (`lib/core/bookkeeping/storno-service.ts`). Storno, never edit.
2. **All journal writes go through `lib/bookkeeping/engine.ts`.** Never insert into journal tables directly: voucher numbers are assigned atomically by the `commit_journal_entry` RPC and must stay sequential, and gaps require documented explanations (BFNAR 2013:2, `voucher_gap_explanations`).
3. **Every entry balances**: `sum(debits) === sum(credits)`, both `> 0`.
4. **Respect period locks.** DB triggers block writes to closed/locked periods and behind the company lock date. Don't work around them: fix the flow that tried to write there.
5. **Never delete documents linked to posted entries**: 7-year retention is a legal requirement.
6. **Money math is `Math.round(x * 100) / 100`.** Never `toFixed()`: it returns strings and rounds incorrectly, causing öre-level drift that breaks entry balance.
7. **Account numbers are strings** (`'1930'`, never `1930`). They are identifiers, not quantities; arithmetic on them is always a bug.

General prohibitions:

- **Never modify an existing migration**: schemas already shipped; create a new migration. Never touch the enforcement triggers (migration 017); they are legally required.
- **Never leave a remote DB ahead of the repo.** If you `apply_migration` (or run any DDL) against prod, staging, or a preview branch, write the byte-identical SQL into `supabase/migrations/` under the exact applied version in the same change. An applied version with no committed file is an orphan: Supabase branching aborts the next merge to `main` with "Remote migration versions not found in local migrations directory" and blocks every pending migration behind it. The PR preview passes anyway (preview branches fork from prod's history, which already has the orphan), so this only surfaces at merge.
- **Core code must never import from `@/extensions/`.** CI builds core with zero extensions enabled; a direct import breaks that build. Extensions cannot use dynamic imports (the registry generates static imports via `setup:extensions`).
- **Don't add dependencies without asking.** This is an AGPL-3.0 project; license compatibility matters, and the dependency surface is audited.
- **Don't "finish" the gnubok → Accounted rename.** Wire-format identifiers keep the old name on purpose: `gnubok-company-id` cookie, `gnubok_sk_`/`gnubok_inv_` prefixes, `gnubok-mcp` npm package. Renaming them breaks live sessions, API keys, and invites.
- **Treat `.env.local` as pointing at the production database.** Never run seed/cleanup/repair scripts against it without explicit confirmation.
- **Keep the diff scoped to the request.** No drive-by refactors of untouched code.
- **Never use em dashes (—) or en dashes (–)** in code, comments, commit messages, or docs. Use a colon, comma, semicolon, or plain hyphen instead, whichever fits the sentence. Exception: a dash character that is the literal subject being parsed, matched, or documented (e.g. mojibake byte-mapping tables, a date-range separator regex) stays as-is; don't launder those into a colon.
- Never create a NUL/nul file: `\Accounted\NUL`.

## When Uncertain

- **Stop and ask; do not guess.** Especially for anything touching posted entries, the production database, money math, or Swedish tax law.
- **Swedish domain questions are never answered from training data.** Load the matching `swedish-*` skill (vat, accounting-compliance, invoice-compliance, payroll, year-end-closing, sie-import-export, sru-filing, financial-reporting, asset-accounting, project-accounting, tax-planning, e-invoicing).
- Scaffolding has skills; use them instead of improvising: `/erp-api-route` (API routes), `/supabase-migration` (migrations), `/create-extension` (extensions), `/frontend-design` (new UI), `vercel:deploy` (deployment).

## Definition of Done

A change is done when all of these hold; iterate until they do:

1. `npm run lint` is clean and `npm test` passes (`npx vitest run <dir>` while iterating).
2. New or changed logic in `lib/` or `app/api/` has tests: auth 401, validation 400, 404, happy path; mock `@/lib/supabase/server`.
3. Any change to a trigger, RPC, RLS policy, or DEFERRABLE constraint ships with a `*.pg.test.ts` (`npm run test:pg`).
4. New UI strings exist in **both** `messages/sv.json` and `messages/en.json`.
5. If you edited an atom `SKILL.md`, `npm run skills:generate` was run (CI's `skills:check` fails otherwise).
6. `npm run check:guards` passes if you touched API routes.
7. Commit is conventional (`feat:`/`fix:`/`refactor:`/`test:`/`docs:`), atomic, branched from `main`.
8. If the change touches migrations, local and prod are reconciled: every version in prod's `schema_migrations` has a matching file in `supabase/migrations/`, and vice versa. Check before opening the PR (e.g. `list_migrations` / `select version from supabase_migrations.schema_migrations`); a remote-only version means an uncommitted orphan that will fail the merge.

## Commands

```bash
npm run dev              # Dev server (runs setup:extensions first)
npm run build            # Production build (runs setup:extensions first)
npm run lint             # ESLint
npm test                 # All Vitest tests
npx vitest run <dir>     # Tests in one directory
npm run test:pg          # pg-real tests against real Postgres
npm run check:guards     # Ratchet guard (e.g. no hand-rolled route auth)
npm run setup:extensions # Regenerate extension registry from extensions.config.json
npm run skills:generate  # Regenerate agent_atom_registry seed after editing an atom SKILL.md
```

## Architecture

- **Journal entry lifecycle**: `createDraftEntry()` → `commitEntry()` (atomic voucher via `commit_journal_entry` RPC); `createJournalEntry()` does both. Everything accounting-shaped routes through this engine.
- **Tenancy**: every business table has `company_id`. Active company resolves in `lib/supabase/middleware.ts`: `gnubok-company-id` cookie → `user_preferences.active_company_id` → first membership. RLS uses `user_company_ids()`; queries still filter by `company_id` explicitly (defense in depth: service-role paths have no RLS).
- **Auth**: Supabase email+password + TOTP MFA, enforced **application-side**, not in RLS. `NEXT_PUBLIC_REQUIRE_MFA=true` on hosted; `NEXT_PUBLIC_SELF_HOSTED=true` disables MFA. API routes wrap `withRouteContext`: it is the only path that enforces MFA, so never hand-roll `supabase.auth.getUser()` in a route.
- **Events**: `lib/events/bus.ts` is a module-level singleton. Any route that emits events must call `ensureInitialized()` (`lib/init.ts`) at module level: otherwise extension handlers are never wired and events silently go nowhere.
- **Supabase clients**: browser `client.ts`, server `createClient()`, service role `createServiceClient()`, cookieless service role `createServiceClientNoCookies()` (lives in `lib/auth/api-keys.ts`; for API-key/MCP paths). Paginate with `fetchAllRows()`: PostgREST silently caps at 1000 rows.
- **Extensions**: opt-in plugins in `extensions/general/<name>/`; `extensions.config.json` is the source of truth for what's enabled. Core must run with zero extensions.
- **MCP server**: the bookkeeping engine is exposed as 100+ MCP tools (`extensions/general/mcp-server/`), authenticated by `gnubok_sk_` API keys (SHA-256, scoped, default 100 RPM per key).
- **Types**: import from `@/types` (`types/index.ts`); event types in `lib/events/types.ts`.
- **User-facing errors are Swedish**: map through `lib/errors/get-error-message.ts`.
- **Cron**: hosted cron jobs live in `vercel.json`, authenticated via `verifyCronSecret()` (`lib/auth/cron.ts`).

## Repository Map

- `lib/bookkeeping/`: engine, entry generators, mapping, templates, BAS 2026 data (`bas-data/`)
- `lib/core/`: period, year-end, storno, tax codes, audit, documents
- `lib/events/`, `lib/auth/`, `lib/supabase/`, `lib/api/` (Zod `validateBody`/`validateQuery`)
- `lib/reports/`: balance sheet, income statement, trial balance, GL, ledgers, VAT, SIE, INK2, NE-bilaga, salary, …
- `lib/invoices/`, `lib/transactions/`, `lib/import/`, `lib/documents/`, `lib/salary/`, `lib/reconciliation/`, `lib/tax/`, `lib/vat/`, `lib/providers/` (Fortnox/Bokio/Briox/BL/Visma), `lib/skatteverket/`, `lib/currency/`, `lib/bankgiro/`, `lib/deadlines/`, `lib/calendar/`
- `lib/utils.ts`: `cn()`, `formatCurrency()`, `formatDate()`, `formatOrgNumber()`; `lib/logger.ts`
- `app/(dashboard)/*` pages; `app/api/*` routes; `supabase/migrations/` schema; `extensions/general/*` plugins

## Testing

Vitest 4, `node` env, tests in `__tests__/`, scope `lib/` + `app/api/` (no component/E2E tests). Helpers in `tests/helpers.ts`: `createMockSupabase()`, `createQueuedMockSupabase()`, `createMockRequest()`, `parseJsonResponse()`, plus fixture factories (`makeTransaction`, `makeJournalEntry`, `makeInvoice`, …). `vi.clearAllMocks()` + `eventBus.clear()` in `beforeEach`. Trigger/RPC/RLS behavior is tested in `*.pg.test.ts` against real Postgres, not with mocks.

## Detail Loads On Demand

Don't duplicate these here; they auto-load when you touch matching paths:

- `.claude/rules/design.md`: design system, locked tokens (`app/**`, `components/**`)
- `.claude/rules/i18n.md`: sv/en conventions, "stays Swedish" surfaces
- `.claude/rules/api-routes.md`: `withRouteContext` route pattern, endpoint map (`app/api/**`)
- `.claude/rules/database.md`: migration rules, key tables/RPCs/triggers, pg-real (`supabase/migrations/**`)
- `.claude/rules/mcp-server.md`: MCP tool authoring, staged-operation pattern
- `.claude/rules/bookkeeping.md`: BAS accounts, VAT treatments/rutor, `lib/core/` services

## Decision Log

When you make a non-obvious choice (picked approach A over B, declined a dependency, stopped because a rule here forbade something), append one line to `DECISIONS.md` (repo root): `[YYYY-MM-DD] <decision>: <why>`. Check that file before re-litigating a past decision.
