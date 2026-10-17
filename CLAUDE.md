# CLAUDE.md: Accounted

Swedish accounting SaaS: double-entry bookkeeping under Swedish accounting law (Bokföringslagen) for sole traders (enskild firma) and limited companies (aktiebolag). Multi-tenant: users belong to companies via `company_members`; `teams` group companies for consultants.

**Stack**: Next.js 16 (App Router), React 19, TypeScript 5 strict, Zod 4, Supabase (Postgres + RLS + auth), Tailwind 4 + shadcn/ui. Vercel-hosted is the primary target; Docker self-hosted must keep working, but never at hosted's expense. Application code lives under `src/` (path alias `@/*`; `@/tests/*` and `@/scripts/*` resolve from the repo root). Paths in older docs and decisions (`lib/...`, `app/...`) are relative to `src/`. All code, comments and commits are in English.

---

## Hard Rules

These are Swedish law, enforced by DB triggers: code that breaks them fails at runtime, and code that works around the triggers breaks compliance.

1. **Posted journal entries change only through the two rättelse paths** (BFL 5 kap 5 §): (a) storno, `reverseEntry()` then `correctEntry()` (`src/lib/core/bookkeeping/storno-service.ts`); (b) inline rättelse, the `correct_entry_metadata` / `correct_entry_lines_inline` RPCs, which strike and replace inside the same verifikat with an immutable who/when log (`journal_entry_rattelse_log`), only in open, unlocked periods. Past a lock, close or declaration, storno is the only path. No other writes to posted entries or their lines, and no deletes.
2. **All journal writes go through `src/lib/bookkeeping/engine.ts`.** The `commit_journal_entry` RPC assigns voucher numbers atomically and they must stay sequential; a gap needs a documented explanation (BFNAR 2013:2, `voucher_gap_explanations`).
3. **Every entry balances**: `sum(debits) === sum(credits)`, both `> 0`.
4. **Period locks hold.** Triggers block writes to closed or locked periods and behind the company lock date. Fix the flow that tried to write there; don't work around the trigger.
5. **Documents linked to posted entries are never deleted**: 7-year retention is law.
6. **Money rounds with `roundOre()` from `src/lib/money.ts`.** `toFixed()` returns strings and rounds wrong, and a hand-rolled `Math.round(x * 100) / 100` rounds exact half-öre by binary representation (1.005 becomes 1.00, 10.075 becomes 10.07). Both cause öre drift that unbalances entries; `check:guards` (naive-ore-round) fails a new one.
7. **Account numbers are strings** (`'1930'`): identifiers, not quantities, so arithmetic on them is always a bug.

General prohibitions:

- Never modify an existing migration or the enforcement triggers (migration 017); add a new migration.
- Prod gets migrations only from CI (`migrations-production` runs `supabase db push --include-all` on every merge to `main`). DDL run by hand anywhere else goes into `supabase/migrations/` byte-identical under the applied version, in the same change: a prod version with no committed file aborts the CI push after the merge and blocks every migration behind it.
- Core never imports from `@/extensions/`: CI builds core with zero extensions. Extensions can't use dynamic imports (`setup:extensions` generates static ones).
- No new dependency without asking: the project is AGPL-3.0 and the dependency surface is audited.
- Don't finish the gnubok → Accounted rename. The `gnubok-company-id` cookie, the `gnubok_sk_`/`gnubok_inv_` prefixes and the `gnubok-mcp` package keep the old name on purpose; renaming them breaks live sessions, API keys, invites and MCP connections. New MCP installs use the additive `accounted-mcp` package and `accounted_*` aliases.
- Treat `.env.local` as production: no seed, cleanup or repair script against it without explicit confirmation.
- Keep the diff to the request; no drive-by refactors of untouched code.
- No em dashes (—) or en dashes (–) in code, comments, commits or docs; use a colon, comma, semicolon or plain hyphen. A dash that is itself the subject (a mojibake table, a date-range regex) stays.
- Never create a file named `NUL` or `nul`: it breaks Windows checkouts.

## Working Autonomy

- Act without asking on anything reversible. Ask first before production writes (data repairs, anything touching posted entries), sending anything to a customer or an authority, deleting data, adding a dependency, or changing how a legal rule is interpreted. A founder's go covers the work through merged and verified live; a long queue or a retry is not a reason to ask again.
- Swedish law is never answered from training data: load the matching `swedish-*` skill.
- New migrations start from `/supabase-migration`, new extensions from `/create-extension`.

## Fix From First Principles

A report usually arrives with a proposed fix; treat it as evidence about the pain, not as the spec. The MR body answers three questions:

1. **Why did it happen?** Name the mechanism and fix the class, not the instance: a wrong number in one place usually means the definition lives in several places, and a bypassed check usually means the invariant lives only in application code.
2. **What could be removed or simplified instead?** Fewer states and less code win unless something concrete needs more.
3. **Why this solution over the proposed one?** Name the alternative and why not. When the better answer changes something users see (a column, a field, a limit), give both options with a recommendation: that choice is the founders'.

## Definition of Done

Iterate until all of these hold:

1. `npm run lint` is clean and `npm test` passes (`npx vitest run <dir>` while iterating).
2. New or changed logic in `src/lib/` or `src/app/api/` has tests: auth 401, validation 400, 404, happy path; mock `@/lib/supabase/server`.
3. A change to a trigger, RPC, RLS policy or DEFERRABLE constraint ships with a `*.pg.test.ts` (`npm run test:pg`).
4. New UI strings exist in both `src/messages/sv.json` and `src/messages/en.json`.
5. After editing an atom `SKILL.md`, `npm run skills:generate` was run (CI's `skills:check` fails otherwise).
6. `npm run check:guards` passes.
7. The commit is conventional (`feat:`/`fix:`/`refactor:`/`test:`/`docs:`), atomic and branched from `main`.
8. With a migration, prod's `schema_migrations` and `supabase/migrations/` match both ways before the MR opens; a prod-only version is an orphan that aborts the CI push after the merge.
9. The last mile is verified in-session, not assumed: migration applied, routine seen firing, script run, feature reachable. An external integration is live only after one real production transaction end to end and a passing scheduled contract test. If switch-on must wait, the final output says what is not live yet and who flips it.
10. The MR body answers the three questions in Fix From First Principles.

## Merging

Merge settings change, so read them first: `glab api projects/87259809 | jq '{merge_method, squash_option, merge_trains_enabled}'`. Merges squash and need a green pipeline.

- Queue with auto-merge: `glab api --method PUT projects/87259809/merge_requests/<n>/merge -f auto_merge=true -f squash=true -f should_remove_source_branch=true`. Never `--auto-merge=false` (with trains on it restarts every pipeline on the train) unless the founders agree an urgent production fix goes first.
- Rebase only when GitLab asks (`need_rebase`, a real conflict), preferably with `glab mr rebase <n>`. After pushing to a queued merge request, check that auto-merge is still set.
- With trains off, reviewed merge requests may land together on one landing branch; with trains on, queue each one.
- After the merge, Vercel deploys `main` (`https://app.accounted.se/api/version` shows the served commit) and the newest main pipeline's `migrations-production` job applies migrations. A failed one is an outage: the code is already live.

## Commands

```bash
npm run dev              # Dev server (runs setup:extensions first)
npm run build            # Production build (runs setup:extensions first)
npm run lint             # ESLint
npm test                 # All Vitest tests
npx vitest run <dir>     # Tests in one directory
npm run test:pg          # pg-real tests against real Postgres
npm run check:guards     # Ratchet guards; each failure prints its fix
npm run check:types      # Typecheck ratchet. `npm test` does NOT typecheck: run this before the build
npm run setup:extensions # Regenerate extension registry from extensions.config.json
npm run skills:generate  # Regenerate agent_atom_registry seed after editing an atom SKILL.md
```

## Architecture

- **Journal entries**: `createDraftEntry()` → `commitEntry()` (atomic voucher via `commit_journal_entry`); `createJournalEntry()` does both. Everything accounting-shaped goes through this engine.
- **Tenancy**: every business table has `company_id`. The active company comes from `user_preferences.active_company_id` (resolved in `src/lib/supabase/middleware.ts`, read by RLS through `current_active_company_id()`), falling back to the first non-archived membership. The `gnubok-company-id` cookie is written but deliberately never read, so Next.js and RLS cannot disagree. Queries still filter by `company_id` explicitly: service-role paths have no RLS.
- **Auth**: email and password plus TOTP MFA, enforced in the application, not in RLS. On hosted, anyone with a verified factor is stepped up to AAL2 whatever `NEXT_PUBLIC_REQUIRE_MFA` says; the flag only decides whether users without a factor must enrol (off in production; BankID users are exempt). `NEXT_PUBLIC_SELF_HOSTED=true` disables MFA gates. Route enforcement: `.claude/rules/api-routes.md`.
- **Events**: `src/lib/events/bus.ts` is a process-wide singleton, and `src/instrumentation.ts` loads `src/lib/init.ts` (core handlers, enabled extensions) on first use. Always `await` `eventBus.emit()` and the async registry getters. Never import `@/lib/init` outside `src/instrumentation.ts`; a script that emits registers the loader (`scripts/lib/register-init-loader.ts`) and runs under `--conditions react-server`. `check:guards` enforces both; details in `.claude/rules/api-routes.md`.
- **Supabase clients**: browser `client.ts`, server `createClient()`, service role `createServiceClient()`, cookieless service role `createServiceClientNoCookies()` (in `src/lib/auth/api-keys.ts`, for API-key and MCP paths). Paginate with `fetchAllRows()`: PostgREST silently caps at 1000 rows.
- **Extensions**: opt-in plugins in `src/extensions/general/<name>/`; `extensions.config.json` says what is enabled. Core must run with zero extensions.
- **MCP server**: the engine is exposed as 150+ MCP tools (`src/extensions/general/mcp-server/`), authenticated by `gnubok_sk_` API keys (SHA-256, scoped, 100 RPM per key by default).
- **Types** come from `@/types` (`src/types/index.ts`); event types from `src/lib/events/types.ts`. **User-facing errors** are Swedish, mapped through `src/lib/errors/get-error-message.ts`. **Cron** jobs live in `vercel.json`, authenticated with `verifyCronSecret()` (`src/lib/auth/cron.ts`).

Path rules in `.claude/rules/` load when you touch matching files: design, i18n, api-routes, database, mcp-server, bookkeeping, legal-forms.

## Testing

Vitest 4, `node` env, tests in `__tests__/`, scope `src/lib/` and `src/app/api/` (no component or E2E tests). Helpers in `tests/helpers.ts`: `createMockSupabase()`, `createQueuedMockSupabase()`, `createMockRequest()`, `parseJsonResponse()`, and fixture factories (`makeTransaction`, `makeJournalEntry`, `makeInvoice`, ...). `vi.clearAllMocks()` and `eventBus.clear()` in `beforeEach`. Trigger, RPC and RLS behavior is tested in `*.pg.test.ts` against real Postgres, not with mocks.

## Decision Log

Record a decision only when it changes a rule, an invariant or something users see, or when you chose against the approach an issue or founder proposed. One file, `docs/decisions/YYYY-MM/YYYY-MM-DD-<slug>.md`, holding one line of at most 300 characters: `[YYYY-MM-DD] <decision>: <why>`. Everything else belongs in the MR body. Never append to `DECISIONS.md` (`check:guards` fails it). Search `docs/decisions/` before re-litigating a past decision; `DECISIONS.md` explains the layout and where older entries live.
