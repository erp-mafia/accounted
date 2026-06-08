# CLAUDE.md — Accounted

## Project Overview

Accounted is a Swedish-focused accounting SaaS for sole traders (enskild firma) and limited companies (aktiebolag). It implements double-entry bookkeeping compliant with Swedish accounting law (Bokföringslagen), including VAT handling, tax reporting, and 7-year document retention. Multi-tenant: each user can own or be a member of multiple companies, optionally grouped into teams (for consultants).

**Tech stack**: Next.js 16.1.5 (App Router), React 19.2.3, TypeScript 5 (strict), Zod 4, Supabase (PostgreSQL + RLS + email/password + TOTP MFA auth), Tailwind CSS 4 + shadcn/ui, Vercel hosting, Docker (self-hosted).

**Integrations**: Enable Banking (PSD2), TIC Identity, Anthropic SDK, AWS Bedrock, OpenAI, Resend, Sentry, Svix, web-push, Upstash Redis, Google Drive, JSZip, sharp, Framer Motion, Recharts, PDF.js, `@react-pdf/renderer`, xlsx, fuse.js, ics.

**Path alias**: `@/*` maps to the project root. **Language**: All code, comments, and commit messages in English. **License**: AGPL-3.0-or-later.

---

## Commands

```bash
npm run dev              # Start dev server (runs setup:extensions first)
npm run build            # Production build (runs setup:extensions first)
npm run lint             # ESLint
npm test                 # Run all Vitest tests
npx vitest run <dir>     # Run tests in a specific directory
npm run test:pg          # pg-real tests against real Postgres
npm run setup:extensions # Regenerate extension registry from extensions.config.json
npm run skills:generate  # Regenerate agent_atom_registry seed migration after editing an atom SKILL.md
npm run skills:check     # CI guard: fail if an atom SKILL.md changed without regenerating the seed migration
```

---

## Key Architectural Relationships

- **Multi-tenant model**: `companies` owns all business data. `company_members` links users to companies (owner/admin/member/viewer). `teams` group companies. Context resolved via `gnubok-company-id` cookie in `lib/supabase/middleware.ts`.
- **All journal entry creation** routes through `lib/bookkeeping/engine.ts`. Lifecycle: `createDraftEntry()` → `commitEntry()` (atomic voucher via `commit_journal_entry` RPC). `createJournalEntry()` does both. Reversal: `reverseEntry()`. Correction: `correctEntry()` in `lib/core/bookkeeping/storno-service.ts`.
- **API routes** emitting events must call `ensureInitialized()` (`lib/init.ts`) at module level to load extensions and wire handlers.
- **Event bus** (`lib/events/bus.ts`) is a module-level singleton using `Promise.allSettled`. 50+ event types in `lib/events/types.ts`. Persisted to `event_log` table (30-day TTL).
- **Supabase clients**: browser (`client.ts`), server cookies (`createClient()`), service role (`createServiceClient()`), cookieless service role for API keys (`createServiceClientNoCookies()`). Pagination: `fetchAllRows()`.
- **Extension system**: Opt-in via `extensions.config.json`. Core runs with zero extensions.
- **Types**: Shared types in `types/index.ts` (~3,100 lines). Import via `import type { T } from '@/types'`. Event types in `lib/events/types.ts`. Extension types in `lib/extensions/types.ts`.
- **Error messages**: `lib/errors/get-error-message.ts` maps to Swedish (Zod → Postgres → HTTP → fallback).

---

## Repository Map

- `lib/bookkeeping/` — Engine, entry generators, mapping, templates, BAS data
- `lib/core/` — Period, year-end, storno, tax codes, audit, documents
- `lib/events/` — Bus singleton, event types, event log handler
- `lib/auth/` — API keys, require-auth/write, MFA, OAuth codes, invite tokens, cron, BankID
- `lib/supabase/` — Clients, middleware, `fetchAllRows` pagination
- `lib/api/` — Zod validation (`validateBody`/`validateQuery`), schemas
- `lib/reports/` — Report generators (balance sheet, income statement, trial balance, GL, AR/supplier ledger, VAT declaration, SIE, INK2, NE-bilaga, KPI, salary, vacation, …)
- `lib/invoices/`, `lib/transactions/`, `lib/import/` (SIE/bank/opening balance), `lib/documents/` (matchers)
- `lib/providers/` — Fortnox, Bokio, Briox, BL, Visma (OAuth, retry, consent)
- `lib/salary/` — Payroll engine, tax tables, AGI, KU, payslips, löneväxling, personnummer
- `lib/reconciliation/`, `lib/tax/`, `lib/vat/` (VIES, MOMS box), `lib/deadlines/`, `lib/currency/` (Riksbanken), `lib/skatteverket/`, `lib/bankgiro/` (Luhn), `lib/calendar/` (ICS)
- `lib/utils.ts` (`cn()`, `formatCurrency()`, `formatDate()`, `formatOrgNumber()`), `lib/logger.ts`
- `app/(dashboard)/*` — pages; `app/api/*` — API routes; `supabase/migrations/` — schema; `extensions/general/*` — opt-in extensions
- Path-scoped detail lives in `.claude/rules/` (see **Path-scoped rules** below).

---

## Multi-Tenant Architecture

- **companies**: Business unit. All business data has a `company_id` column.
- **company_members**: Roles `owner`/`admin`/`member`/`viewer`, source `direct`|`team`.
- **teams**: Consultant grouping. Team members auto-sync to company_members via DB triggers.
- **user_preferences**: Stores `active_company_id` and `locale`.

**Context resolution** (`lib/supabase/middleware.ts`): cookie → `user_preferences.active_company_id` → first membership. RLS uses `user_company_ids()` helper.

**Invitations**: `company_invitations`/`team_invitations` with `gnubok_inv_` tokens (SHA-256, 7-day TTL). See `lib/auth/invite-tokens.ts`.

---

## Authentication

Supabase Auth: email+password (primary), magic link (fallback), TOTP MFA. MFA enforced **application-side** (middleware + API routes), not in RLS.

- `NEXT_PUBLIC_SELF_HOSTED=true` → MFA never enforced
- `NEXT_PUBLIC_REQUIRE_MFA=true` → middleware redirects to `/mfa/enroll` or `/mfa/verify` until AAL2

**API route auth** (`lib/auth/require-auth.ts`): `requireAuth()` returns `{ user, supabase, error }`, enforces MFA on hosted.
**API keys** (`lib/auth/api-keys.ts`): SHA-256 hashed, `gnubok_sk_` prefix. Scoped via `TOOL_SCOPE_MAP`. Rate limited 100 RPM via `validate_and_increment_api_key` RPC.
**Cron auth** (`lib/auth/cron.ts`): `verifyCronSecret()` constant-time comparison.

---

## Core Bookkeeping Engine

The engine (`lib/bookkeeping/engine.ts`) is the most critical system. All accounting flows route through it.

**Lifecycle**: `createDraftEntry()` → `commitEntry()` (atomic voucher via `commit_journal_entry` RPC). `createJournalEntry()` does both. `reverseEntry()` for storno; `correctEntry()` (`lib/core/bookkeeping/storno-service.ts`) for corrections.

**Engine files**: `transaction-entries.ts`, `invoice-entries.ts` (with `generatePerRateLines()` for mixed-rate), `supplier-invoice-entries.ts`, `vat-entries.ts`, `currency-revaluation.ts`, `mapping-engine.ts`, `booking-templates.ts`/`counterparty-templates.ts`, `propose-payment-lines.ts`/`propose-send-lines.ts`, `handlers/supplier-invoice-handler.ts`.

**BAS data** (`lib/bookkeeping/bas-data/`): Full BAS 2026 chart by class (1–8) + SRU mapping.

Key BAS accounts, VAT treatments, VAT declaration rutor, and `lib/core/` services are in `.claude/rules/bookkeeping.md`. For accounting-law questions use the Swedish domain skills.

---

## Accounting Guard Rails

These rules exist for legal compliance, enforced by database triggers. **Never violate them.**

1. **Committed entries are immutable.** Once `status: 'posted'`, cannot be edited or deleted (DB trigger).
2. **Never delete posted entries.** Use `reverseEntry()` (storno) to cancel.
3. **Every entry must balance.** `sum(debits) === sum(credits)`, both `> 0`.
4. **Voucher numbers are sequential.** Assigned atomically via `commit_journal_entry` DB RPC. Never set manually.
5. **Voucher gap documentation.** BFNAR 2013:2 requires documented explanations for gaps (`voucher_gap_explanations` table, `detect_voucher_gaps` RPC).
6. **Period lock enforcement.** DB trigger blocks writes to closed/locked periods. Company-wide lock date enforced via `enforce_company_lock_date()` trigger.
7. **7-year document retention.** DB triggers prevent deletion of documents linked to posted entries.
8. **Storno, never edit.** Use `correctEntry()` from `lib/core/bookkeeping/storno-service.ts`.
9. **Use `Math.round(x * 100) / 100`** for monetary calculations. Never `toFixed()`.
10. **Always use engine functions.** Never insert directly into journal tables.
11. **Account numbers are strings.** `'1930'`, never `1930`.

---

## Extension System

Extensions are opt-in plugins in `extensions/general/<name>/`, controlled by `extensions.config.json`. Core runs with zero extensions. `npm run setup:extensions` generates static imports in `lib/extensions/_generated/` (auto via `predev`/`prebuild`). Extensions **cannot** use dynamic imports.

**Enabled** (`extensions.config.json`): `enable-banking` (PSD2), `email` (Resend), `arcim-migration`, `tic` (org lookup), `mcp-server`, `cloud-backup` (Google Drive), `skatteverket`, `invoice-inbox`, `document-extraction`. **Present but disabled**: `calendar`, `push-notifications`, `example-logger` (plus the `_example-branding` template).

- **Registration** (`lib/extensions/registry.ts`): Singleton. `register()` wires handlers. `get(id)`, `getAll()`, `getByCapability(key)`.
- **Context** (`lib/extensions/context-factory.ts`): `ExtensionContext` = `userId`, `companyId`, `extensionId`, `supabase`, `emit()`, `settings`, `storage`, `log`, `services`.
- **Creating**: use the `/create-extension` skill, or `npx tsx scripts/create-extension.ts --name my-ext --sector general --category operations --description "..."`.

---

## MCP Server & API Keys

Accounted exposes its bookkeeping engine as an MCP server (`extensions/general/mcp-server/`) for Claude Desktop/Code — 90+ tools, JSON-RPC 2.0, endpoint `/api/extensions/ext/mcp-server/mcp`, OAuth 2.1 for Claude connectors. npm bridge: `packages/gnubok-mcp` (`npx gnubok-mcp`).

**API keys** (`lib/auth/api-keys.ts`, `api_keys` table): SHA-256, `gnubok_sk_` prefix, scoped via `TOOL_SCOPE_MAP`, 100 RPM via `validate_and_increment_api_key` RPC. `createServiceClientNoCookies()` — all queries filter by `company_id` (defense in depth).

Tool authoring conventions, the staged-operation completion-signal pattern, and OAuth details are in `.claude/rules/mcp-server.md`.

---

## Testing

**Framework**: Vitest 4, `node` env, tests in `__tests__/`. Scope: `lib/` and `app/api/`. No component/E2E tests.

**Helpers** (`tests/helpers.ts`): `createMockSupabase()`, `createQueuedMockSupabase()`, `createMockRequest()`, `parseJsonResponse()`, `createMockRouteParams()`, plus fixture factories (`makeTransaction`, `makeJournalEntry`, `makeInvoice`, `makeCustomer`, `makeSupplier`, `makeSupplierInvoice`, `makeFiscalPeriod`, etc.).

**Patterns**: Always mock `@/lib/supabase/server`. `vi.clearAllMocks()` + `eventBus.clear()` in `beforeEach`. Test auth (401), validation (400), 404, 500, happy path.

**pg-real**: Parallel Vitest project for triggers/RPCs/RLS using real Postgres. File convention `*.pg.test.ts`. **Required**: any PR touching a trigger/RPC/RLS/DEFERRABLE must include or extend a `*.pg.test.ts`. (Details in `.claude/rules/database.md`.)

---

## Skills, Git & CI

**Skills**: Use `/frontend-design` for new UI, `vercel:deploy` for deployment, `/supabase-migration` for new migrations, `/erp-api-route` for new API routes, `/create-extension` for new extensions. Use the Swedish domain skills (`swedish-vat`, `swedish-accounting-compliance`, `swedish-invoice-compliance`, `swedish-payroll`, `swedish-year-end-closing`, `swedish-sie-import-export`, `swedish-sru-filing`, `swedish-financial-reporting`, `swedish-asset-accounting`, `swedish-project-accounting`, `swedish-tax-planning`, `swedish-e-invoicing`) for accounting domain questions. The `swedish-*`, `industry/*`, and `modifier/*` skills also ship as product atoms (see `.claude/rules/database.md`).

**Git**: Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Atomic commits, branch from `main`.

**CI**:
- `.github/workflows/core-build.yml` — resets extensions to empty, runs build + test, verifies no core code imports from `@/extensions/` directly.
- `.github/workflows/swedish-compliance-review.yml` — Swedish accounting compliance review on PRs touching bookkeeping/reports/tax logic.
- `.github/workflows/docker-publish.yml` — pushes images to GHCR (`erp-mafia/erp-base`) on main.

---

## Deployment

- **Vercel (hosted)**: Cron jobs in `vercel.json` (deadline status, invoice reminders, tax deadlines, enable-banking sync, document verify, sandbox cleanup, event log cleanup, cloud-backup auto-sync).
- **Docker (self-hosted)**: 4-stage Node 22 Alpine `Dockerfile` (standalone output) + `docker-compose.yml` (app + supercronic cron). `docker-entrypoint.sh` validates env vars and replaces build-time placeholders in `.next/static/`. Extension presets: `docker/extensions.{self-hosted,hosted}.json`.

**Environment variables**:
- **Required**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`, `CRON_SECRET`
- **Auth**: `NEXT_PUBLIC_REQUIRE_MFA` (set `true` on hosted), `NEXT_PUBLIC_SELF_HOSTED` (set `true` for Docker)
- **Extension-specific** (only when enabled): `ENABLE_BANKING_APP_ID`/`ENABLE_BANKING_APP_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `RESEND_API_KEY`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`
- **Optional**: `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`

---

## Path-scoped rules (`.claude/rules/`)

Topic detail loads automatically when Claude touches matching files:

- `design.md` — design context & locked design-system tokens (`app/**`, `components/**`)
- `i18n.md` — bilingual sv/en conventions + "stays Swedish" surfaces (UI + `lib/email|invoices|reports|salary`)
- `api-routes.md` — API route pattern + endpoint map (`app/api/**`)
- `database.md` — migration rules, key tables/RPCs/triggers, `agent_atom_registry` (`supabase/migrations/**`)
- `mcp-server.md` — MCP tool authoring conventions (`extensions/general/mcp-server/**`)
- `bookkeeping.md` — BAS accounts, VAT treatments/rutor, `lib/core/` services (`lib/bookkeeping|core|reports|vat|invoices|salary`)

---

## Other

Never create a NUL/nul file: `\Accounted\NUL`.
