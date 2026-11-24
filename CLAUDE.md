# CLAUDE.md: Accounted

Swedish accounting SaaS: double-entry bookkeeping under Swedish accounting law (Bokföringslagen) for sole traders (enskild firma) and limited companies (aktiebolag). Multi-tenant: users belong to companies via `company_members`; `teams` group companies for consultants.

**Stack**: Next.js 16 (App Router), React 19, TypeScript 5 strict, Zod 4, Supabase (Postgres + RLS + auth), Tailwind 4 + shadcn/ui. Vercel-hosted is the primary target; Docker self-hosted must keep working, but never at hosted's expense. Application code lives under `src/` (path alias `@/*`; `@/tests/*` and `@/scripts/*` resolve from the repo root). Paths in older docs (`lib/...`, `app/...`) are relative to `src/`. All code, comments and commits are in English.

How to contribute, including the policy for AI-assisted pull requests: [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md).

---

## Hard Rules

These are Swedish law, enforced by DB triggers: code that breaks them fails at runtime, and code that works around the triggers breaks compliance.

1. **Posted journal entries change only through the two rättelse paths** (BFL 5 kap 5 §): (a) storno, `reverseEntry()` then `correctEntry()` (`src/lib/core/bookkeeping/storno-service.ts`); (b) inline rättelse, the `correct_entry_metadata` / `correct_entry_lines_inline` RPCs, which strike and replace inside the same verifikat with an immutable who/when log (`journal_entry_rattelse_log`), only in open, unlocked periods. Past a lock, close or lock date, storno is the only path. A filed VAT or AGI declaration freezes nothing: both paths stay open while the period does, and the VAT page shows every change to a filed period (`src/lib/vat/filed-period-changes.ts`) so the declaration gets corrected. No other writes to posted entries or their lines, and no deletes.
2. **All journal writes go through `src/lib/bookkeeping/engine.ts`.** The `commit_journal_entry` RPC assigns voucher numbers atomically and they must stay sequential; a gap needs a documented explanation (BFNAR 2013:2, `voucher_gap_explanations`).
3. **Every entry balances**: `sum(debits) === sum(credits)`, both `> 0`.
4. **Period locks hold.** Triggers block writes to closed or locked periods and behind the company lock date. Fix the flow that tried to write there; don't work around the trigger.
5. **Documents linked to posted entries are never deleted**: 7-year retention is law.
6. **Money rounds with `roundOre()` from `src/lib/money.ts`.** `toFixed()` returns strings and rounds wrong, and a hand-rolled `Math.round(x * 100) / 100` rounds exact half-öre by binary representation (1.005 becomes 1.00, 10.075 becomes 10.07). Both cause öre drift that unbalances entries; `check:guards` (naive-ore-round) fails a new one.
7. **Account numbers are strings** (`'1930'`): identifiers, not quantities, so arithmetic on them is always a bug.

General prohibitions:

- Never modify an existing migration or the enforcement triggers (migration 017); add a new migration. A new public table, view or sequence is granted by name in the migration that creates it; `check:guards` (table-without-grant) prints the lines.
- Core never imports from `@/extensions/`: CI builds core with zero extensions. Extensions can't use dynamic imports (`setup:extensions` generates static ones).
- No new dependency without asking: the project is AGPL-3.0 and the dependency surface is audited.
- Don't finish the gnubok → Accounted rename. The `gnubok-company-id` cookie, the `gnubok_sk_`/`gnubok_inv_` prefixes and the `gnubok-mcp` package keep the old name on purpose; renaming them breaks live sessions, API keys, invites and MCP connections. New MCP installs use the additive `accounted-mcp` package and `accounted_*` aliases.
- Keep the diff to the request; no drive-by refactors of untouched code.
- A business rule has one definition. Before writing a calculation, status, date, default or check, search `scripts/checks/one-definition/`: each file names a rule and its home, and `check:guards` fails a new copy. Giving a rule a home adds a file there.
- No em dashes (—) or en dashes (–) in code, comments, commits or docs; use a colon, comma, semicolon or plain hyphen. A dash that is itself the subject (a mojibake table, a date-range regex) stays.
- Never create a file named `NUL` or `nul`: it breaks Windows checkouts.

## When Uncertain

- Stop and ask in the issue or pull request; do not guess. Especially for anything touching posted entries, money math or Swedish tax law.
- Swedish domain questions are never answered from training data: load the matching skill from `.claude/skills/` (`swedish-vat`, `swedish-accounting-compliance`, `swedish-invoice-compliance`, `swedish-e-invoicing`, `swedish-payroll`, `swedish-year-end-closing`, `swedish-financial-reporting`, `swedish-sie-import-export`, `swedish-sru-filing`, `swedish-asset-accounting`, `swedish-project-accounting`, `swedish-tax-planning`, `swedish-ef-skatteplanering`, `swedish-daily-bookkeeping`, `swedish-cash-register`, `swedish-inventory`).
- New extensions start from `npx tsx scripts/create-extension.ts` ([docs/EXTENSIONS.md](docs/EXTENSIONS.md)).

## Definition of Done

Iterate until all of these hold:

1. `npm run lint` is clean and `npm test` passes (`npx vitest run <dir>` while iterating).
2. New or changed logic in `src/lib/` or `src/app/api/` has tests: auth 401, validation 400, 404, happy path; mock `@/lib/supabase/server`.
3. A change to a trigger, RPC, RLS policy or DEFERRABLE constraint ships with a `*.pg.test.ts` (`npm run test:pg`).
4. New UI strings exist in both `src/messages/sv.json` and `src/messages/en.json`.
5. After editing an atom `SKILL.md` under `.claude/skills/`, `npm run skills:generate` was run (CI's `skills:check` fails otherwise).
6. `npm run check:guards` passes.
7. The commit is conventional (`feat:`/`fix:`/`refactor:`/`test:`/`docs:`), atomic and branched from `main`.
8. The pull request says what changed and why, including any non-obvious choice, and follows [CONTRIBUTING.md](.github/CONTRIBUTING.md). Never append to `DECISIONS.md`.

## Commands

```bash
npm run dev              # Dev server (runs setup:extensions first)
npm run build            # Production build (runs setup:extensions first)
npm run lint             # ESLint
npm test                 # All Vitest tests
npx vitest run <dir>     # Tests in one directory
npm run test:pg          # pg-real tests against real Postgres
npm run test:sim         # Moms, AGI, INK2 and årsredovisning against the simulated company
npm run check:guards     # Ratchet guards; each failure prints its fix
npm run law:refs -- "ML 17 kap 24 §"  # What in the repo cites a provision (any spelling); no argument lists the laws
npm run check:types      # Typecheck ratchet. `npm test` does NOT typecheck: run this before the build
npm run setup:extensions # Regenerate extension registry from extensions.config.json
npm run skills:generate  # Regenerate agent_atom_registry seed after editing an atom SKILL.md
```

## Architecture

More in [docs/architecture.md](docs/architecture.md) and [docs/EXTENSIONS.md](docs/EXTENSIONS.md).

- **Journal entries**: `createDraftEntry()` → `commitEntry()` (atomic voucher via `commit_journal_entry`); `createJournalEntry()` does both. Everything accounting-shaped goes through this engine.
- **Tenancy**: every business table has `company_id`. The active company comes from `user_preferences.active_company_id` (resolved in `src/lib/supabase/middleware.ts`, read by RLS through `current_active_company_id()`), falling back to the first non-archived membership. The `gnubok-company-id` cookie is written but deliberately never read, so Next.js and RLS cannot disagree. Queries still filter by `company_id` explicitly: service-role paths have no RLS.
- **Auth**: email and password plus TOTP MFA, enforced in the application, not in RLS. `NEXT_PUBLIC_SELF_HOSTED=true` disables MFA gates. Cookie-session API routes wrap `withRouteContext` (`src/lib/api/with-route-context.ts`): it is the only path that enforces MFA, so never hand-roll `supabase.auth.getUser()` in a route (`check:guards` fails it).
- **Server-held session**: the session cookie is HttpOnly and every server-set cookie goes through `src/lib/supabase/cookie-options.ts`. The browser client has no `auth`: sign-in, MFA, the current user and sign-out go through `src/lib/auth/session-client.ts` to `/api/auth/*`. Never add a browser `supabase.auth` call or a script-readable session cookie.
- **Events**: `src/lib/events/bus.ts` is a process-wide singleton, and `src/instrumentation.ts` loads `src/lib/init.ts` (core handlers, enabled extensions) on first use. Always `await` `eventBus.emit()`. Never import `@/lib/init` outside `src/instrumentation.ts`; a script that emits registers the loader (`scripts/lib/register-init-loader.ts`) and runs under `--conditions react-server`. `check:guards` enforces both.
- **Supabase clients**: browser `client.ts`, server `createClient()`, service role `createServiceClient()`, cookieless service role `createServiceClientNoCookies()` (in `src/lib/auth/api-keys.ts`, for API-key and MCP paths). Paginate with `fetchAllRows()`: PostgREST silently caps at 1000 rows.
- **Legal forms**: behaviour per legal form comes from its profile in `src/lib/company/forms/`, read as capabilities; never compare `entity_type === 'aktiebolag'` at a call site. Contract: [docs/LEGAL-FORMS.md](docs/LEGAL-FORMS.md).
- **Extensions**: opt-in plugins in `src/extensions/general/<name>/`; `extensions.config.json` says what is enabled. Core must run with zero extensions.
- **MCP server**: the engine is exposed as 150+ MCP tools (`src/extensions/general/mcp-server/`), authenticated by `gnubok_sk_` API keys (SHA-256, scoped, 100 RPM per key by default).
- **Types** come from `@/types` (`src/types/index.ts`); event types from `src/lib/events/types.ts`. **User-facing errors** are Swedish, mapped through `src/lib/errors/get-error-message.ts`. **Cron** jobs live in `vercel.json`, authenticated with `verifyCronSecret()` (`src/lib/auth/cron.ts`).

## Repository Map

- `src/lib/bookkeeping/`: engine, entry generators, mapping, templates, BAS data (`bas-data/`)
- `src/lib/core/`: period, year-end and storno services (`bookkeeping/`), audit, documents
- `src/lib/events/`, `src/lib/auth/`, `src/lib/supabase/`, `src/lib/api/` (Zod `validateBody`/`validateQuery`)
- `src/lib/reports/`: balance sheet, income statement, trial balance, general ledger, ledgers, VAT, SIE, INK2, NE-bilaga, ...
- `src/lib/invoices/`, `src/lib/transactions/`, `src/lib/import/`, `src/lib/documents/`, `src/lib/salary/`, `src/lib/reconciliation/`, `src/lib/tax/`, `src/lib/vat/`, `src/lib/bokslut/`, `src/lib/company/`, `src/lib/providers/`, `src/lib/skatteverket/`, `src/lib/currency/`, `src/lib/bankgiro/`, `src/lib/deadlines/`
- `src/lib/money.ts` (`roundOre()`), `src/lib/utils.ts` (`cn()`, `formatCurrency()`, `formatDate()`, `formatOrgNumber()`), `src/lib/logger.ts`
- `src/app/(dashboard)/*` pages, `src/app/api/*` routes, `src/components/`, `src/messages/` (sv, en), `src/extensions/general/*` plugins
- `supabase/migrations/` schema; `tests/` helpers and pg-real tests; `scripts/` guards and generators
- `packages/`: `accounted-mcp`, `gnubok-mcp`, `accounted-cli`, `claude-plugin`, `connect-contract`
- `.claude/skills/`: Swedish domain skills (`swedish-*`, `industry/`, `modifier/`), also seeded into the app as agent knowledge; `skills/`: installable skills for API and CLI consumers

## Testing

Vitest 4, `node` env, tests in `__tests__/`, scope `src/lib/` and `src/app/api/` (no component or E2E tests). Helpers in `tests/helpers.ts`: `createMockSupabase()`, `createQueuedMockSupabase()`, `createMockRequest()`, `parseJsonResponse()`, and fixture factories (`makeTransaction`, `makeJournalEntry`, `makeInvoice`, ...). `vi.clearAllMocks()` and `eventBus.clear()` in `beforeEach`. Trigger, RPC and RLS behavior is tested in `*.pg.test.ts` against real Postgres, not with mocks. `tests/sim/` runs a company through three years with the real MCP tools and judges the reports against an independent answer key.
