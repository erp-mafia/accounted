# CLAUDE.md — Gnubok

## Project Overview

gnubok is a Swedish-focused accounting SaaS for sole traders (enskild firma) and limited companies (aktiebolag). It implements double-entry bookkeeping compliant with Swedish accounting law (Bokforingslagen), including VAT handling, tax reporting, and 7-year document retention. Multi-tenant: each user can own or be a member of multiple companies, optionally grouped into teams (for consultants).

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
npm run setup:extensions # Regenerate extension registry from extensions.config.json
npm run skills:generate  # Regenerate agent_atom_registry seed migration from .claude/skills/**/SKILL.md (after editing a SKILL.md)
npm run skills:check     # CI guard: fail if a SKILL.md changed without regenerating the seed migration
```

---

## Key Architectural Relationships

- **Multi-tenant model**: `companies` owns all business data. `company_members` links users to companies (owner/admin/member/viewer). `teams` group companies. Context resolved via `gnubok-company-id` cookie in `lib/supabase/middleware.ts`.
- **All journal entry creation** routes through `lib/bookkeeping/engine.ts`. Lifecycle: `createDraftEntry()` → `commitEntry()` (atomic voucher via `commit_journal_entry` RPC). `createJournalEntry()` does both. Reversal: `reverseEntry()`. Correction: `correctEntry()` in `lib/core/bookkeeping/storno-service.ts`.
- **API routes** emitting events must call `ensureInitialized()` (`lib/init.ts`) at module level to load extensions and wire handlers.
- **Event bus** (`lib/events/bus.ts`) is a module-level singleton using `Promise.allSettled`. 36 event types in `lib/events/types.ts`. Persisted to `event_log` table (30-day TTL).
- **Supabase clients**: browser (`client.ts`), server cookies (`createClient()`), service role (`createServiceClient()`), cookieless service role for API keys (`createServiceClientNoCookies()`). Pagination: `fetchAllRows()`.
- **Extension system**: Opt-in via `extensions.config.json`. Core runs with zero extensions. Enabled: `enable-banking`, `email`, `arcim-migration`, `tic`, `mcp-server`, `cloud-backup`.
- **Core reports** (`lib/reports/`): balance sheet, income statement, trial balance, general ledger, AR/supplier ledger + reconciliation, VAT declaration, journal register, monthly breakdown, continuity check, opening balances, KPI, NE-bilaga, INK2, SIE export, full archive, salary journal, vacation liability, avgifter basis.
- **Types**: Shared types in `types/index.ts` (~2,570 lines). Import via `import type { T } from '@/types'`. Event types in `lib/events/types.ts`. Extension types in `lib/extensions/types.ts`.
- **Error messages**: `lib/errors/get-error-message.ts` maps to Swedish (Zod → Postgres → HTTP → fallback).

---

## Multi-Tenant Architecture

- **companies**: Business unit. All business data has a `company_id` column.
- **company_members**: Roles `owner`/`admin`/`member`/`viewer`, source `direct`|`team`.
- **teams**: Consultant grouping. Team members auto-sync to company_members via DB triggers.
- **user_preferences**: Stores `active_company_id`.

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

**BAS data** (`bookkeeping/bas-data/`): Full BAS 2026 chart by class (1–8) + SRU mapping.

### Key BAS Accounts

`1510` Accounts receivable | `1930` Business bank account | `2013` Private withdrawals (EF) | `2440` Accounts payable | `2611`/`2621`/`2631` Output VAT 25%/12%/6% | `2641` Input VAT | `2645` Calculated input VAT (EU) | `2893` Shareholder loan (AB) | `3001`/`3002`/`3003` Revenue 25%/12%/6% | `3305`/`3308` Export/EU service revenue

### VAT Treatments

`standard_25`, `reduced_12`, `reduced_6`, `reverse_charge`, `export`, `exempt`

Invoice items support individual `vat_rate` values (mixed-rate invoices). Use `getAvailableVatRates(customerType, vatNumberValidated)` from `lib/invoices/vat-rules.ts`. VIES validation via `lib/vat/vies-client.ts`.

### VAT Declaration Rutor (SKV 4700)

`VatDeclarationRutor` type maps to momsdeklaration:
- **Ruta 05**: Domestic taxable sales (3001+3002+3003)
- **Ruta 06/07**: Unused, always 0
- **Ruta 10/11/12**: Output VAT 25%/12%/6% (2611/2621/2631)
- **Ruta 39/40**: EU services / Export (3308/3305)
- **Ruta 48**: Input VAT (2641/2645)
- **Ruta 49**: Moms att betala/återfå = (10+11+12+30+31+32+60+61+62) − 48

---

## Core Services (`lib/core/`)

- `bookkeeping/period-service.ts` — Fiscal period lifecycle management (open, close, lock)
- `bookkeeping/year-end-service.ts` — Year-end closing procedures
- `bookkeeping/storno-service.ts` — Reversal/correction entry generation
- `tax/tax-code-service.ts` — Tax code definitions and rates
- `audit/audit-service.ts` — Audit trail and compliance logging
- `documents/document-service.ts` — Document attachment lifecycle (WORM storage with version chains)

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

**Available (12)**: Enabled — `enable-banking` (PSD2), `email` (Resend), `arcim-migration`, `tic` (org lookup), `mcp-server`, `cloud-backup` (Google Drive). Disabled — `inbox-smart-match`, `invoice-inbox`, `push-notifications`, `calendar`, `skatteverket`, `example-logger`.

**Registration** (`lib/extensions/registry.ts`): Singleton. `register()` wires handlers. `get(id)`, `getAll()`, `getByCapability(key)`.
**Context** (`lib/extensions/context-factory.ts`): `ExtensionContext` = `userId`, `companyId`, `extensionId`, `supabase`, `emit()`, `settings`, `storage`, `log`, `services`.
**API routes**: `app/api/extensions/ext/[...path]/route.ts` catch-all → `/api/extensions/ext/{extensionId}/{routePath}`. Path params as `_paramName` query.
**Service patterns**: Interface registration (email — `registerEmailService()`/`getEmailService()`) or services record (extension exposes via `services` property).
**Creating**: `npx tsx scripts/create-extension.ts --name my-ext --sector general --category operations --description "..."`.

---

## MCP Server & API Keys

gnubok exposes its bookkeeping engine as an MCP server for Claude Desktop/Code.

**MCP extension** (`extensions/general/mcp-server/`): 35 tools covering transactions, categorization, customers/suppliers, invoices, accounts, fiscal periods, reports (trial balance, GL, BS, IS, AR/supplier ledger, VAT, KPI), reconciliation, salary runs, AGI, document upload. JSON-RPC 2.0. Endpoint: `/api/extensions/ext/mcp-server/mcp`.

**API keys** (`lib/auth/api-keys.ts`, `api_keys` table): SHA-256, `gnubok_sk_` prefix, scoped via `TOOL_SCOPE_MAP`, 100 RPM via `validate_and_increment_api_key` RPC. `createServiceClientNoCookies()` — all queries filter by `company_id` (defense in depth).

**OAuth 2.1** for Claude connectors: `.well-known/oauth-protected-resource` + `.well-known/oauth-authorization-server` discovery; `/api/mcp-oauth/authorize`, `/token` (PKCE), `/register`. Stateless AES-256-GCM auth codes (`lib/auth/oauth-codes.ts`). Single-use via `oauth_used_codes`. Allowlist: `claude.ai/api/*`, `claude.com/api/*`, `localhost`.

**npm package** (`packages/gnubok-mcp`): Stdio-to-HTTP bridge; users run `npx gnubok-mcp` with API key.

**Tool authoring conventions** (enforced by tests):
- Every `inputSchema` must declare `additionalProperties: false` at the top level. Guarded by `extensions/general/mcp-server/__tests__/strict-schemas.test.ts`.
- Tool descriptions must be ≤ 280 chars (guarded by `output-schema.test.ts`). No `Args:` / `Returns:` / `Examples:` blocks — those belong in JSON Schema, not description prose. Use agent-native hints like "Use to…" / "Call X first" instead.
- Completion-signal pattern: write tools that stage operations return `STAGED_OPERATION_SCHEMA` (`server.ts:495`) — `{ staged, risk_level, actor, message, preview, period_status?, next? }`. The `staged: true` boolean is the explicit completion signal; agents must not infer completion from prose. Do NOT introduce a parallel `{ success, shouldContinue, output }` envelope.
- Tools that touch a fiscal-period-bound date (categorize, mark paid, create voucher, correct/reverse entry, approve supplier invoice) pass `dateForPeriodCheck` to `stagePendingOperation` so the response includes `period_status: { period_id, status: open|locked|closed, lock_date }`. Widgets and agents use this to disable writes without round-trips.

---

## API Route Pattern

```typescript
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { MySchema } from '@/lib/api/schemas'

ensureInitialized()  // Module-level — loads extensions for event emission

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const result = await validateBody(request, MySchema)
  if (!result.success) return result.response

  // Business logic... always filter by company_id (defense in depth alongside RLS)
  return NextResponse.json({ data: result })
}
```

- Dynamic route params: `{ params }: { params: Promise<{ id: string }> }` (Next.js 16)
- Response shapes: `{ data }` for success, `{ error }` for failures
- Zod schemas in `lib/api/schemas.ts` — 30+ schemas with shared primitives (uuid, isoDate, accountNumber, nonNegativeAmount)

---

## Key lib/ Directories

- `bookkeeping/` — Engine, entry generators, mapping, templates, BAS data
- `core/` — Period, year-end, storno, tax codes, audit, documents
- `events/` — Bus singleton, 36 event types, event log handler
- `auth/` — API keys, require-auth/write, MFA, OAuth codes, invite tokens, cron, BankID
- `supabase/` — Clients, middleware, `fetchAllRows` pagination
- `api/` — Zod validation (`validateBody`/`validateQuery`), schemas
- `reports/` — 20 report generators
- `invoices/` — Matching, payment log, reminders, VAT rules, PDF
- `transactions/` — `ingest.ts`, AI suggestions
- `import/` — SIE, bank file, opening balance, account mapper
- `documents/` — Matchers (single + batch)
- `extensions/` — Registry, loader, context factory
- `email/` — Service interface, Resend, templates
- `company/` — Context resolution, CRUD, fiscal period computation
- `providers/` — Fortnox, Bokio, Briox, BL, Visma (OAuth, retry, consent)
- `salary/` — Payroll engine, tax tables, AGI, KU, payslips, löneväxling, personnummer
- `processing-history/`, `reconciliation/`, `tax/`, `vat/` (VIES, MOMS box), `deadlines/`, `currency/` (Riksbanken), `skatteverket/`, `bankgiro/` (Luhn), `calendar/` (ICS)
- `errors/` — Swedish error mapping (Zod → Postgres → HTTP → fallback)
- `rate-limits/` — Postgres-backed `checkInboxUploadRateLimit` via `check_and_increment_inbox_quota` RPC; fails open
- `hooks/`, `logger.ts`, `support.ts`, `utils.ts` (`cn()`, `formatCurrency()`, `formatDate()`, `formatOrgNumber()`)

---

## App Routes

**Pages**: `/login`, `/register`, `/reset-password`, `/mfa/{enroll,verify}`, `/onboarding`, `/companies/new`, `/invite/[token]`, `/` (dashboard), `/transactions`, `/invoices[/new|/[id]|/[id]/credit]`, `/supplier-invoices[/new|/[id]]`, `/customers[/[id]]`, `/suppliers[/[id]]`, `/expenses[/new|/[id]]`, `/receipts[/scan]`, `/bookkeeping[/[id]|/year-end]`, `/salary[/employees|/runs]`, `/reports`, `/import`, `/kpi`, `/deadlines`, `/pending`, `/help`, `/extensions[/[sector]/[ext]]`, `/e/[sector]/[slug]` (workspace), `/settings/*`, `/dpa`, `/privacy`, `/invoice-action/[token]`, `/sandbox`.

**API endpoints**:
- `/api/bookkeeping/*` — accounts, fiscal periods, journal entries (CRUD/reverse/correct), mapping rules, voucher gaps
- `/api/invoices/*`, `/api/supplier-invoices/*` — CRUD + state transitions
- `/api/transactions/*` — categorize, describe, book, match-{invoice,supplier-invoice}, batch, AI suggestions
- `/api/customers/*`, `/api/suppliers/*` — CRUD
- `/api/documents/*` — CRUD, versions, link, match-sweep, verify cron
- `/api/reports/*` — 19 endpoints (GL, TB, BS, IS, AR/supplier ledger, VAT, SIE, INK2, NE-bilaga, KPI, audit, continuity, monthly, full-archive, salary, vacation, avgifter)
- `/api/salary/*` — employees, payroll-config, tax-tables, KU, runs
- `/api/import/*` — bank-file, SIE (parse/execute/mappings)
- `/api/reconciliation/bank/*`, `/api/settings/*`, `/api/company/*`, `/api/team/*`
- `/api/deadlines/*`, `/api/tax-deadlines/*` — CRUD + crons
- `/api/pending-operations/*`, `/api/events/*`, `/api/audit-trail/*`
- `/api/calendar/feed/[token]`, `/api/mcp-oauth/*`, `/api/support/contact`, `/api/account/delete`
- `/api/log`, `/api/health`, `/api/vat/validate`, `/api/currency/rate`, `/api/sandbox/*`
- `/api/extensions/ext/[...path]` — dynamic extension routes

---

## Testing

**Framework**: Vitest 4, `node` env, tests in `__tests__/`. Scope: `lib/` and `app/api/`. No component/E2E tests.

**Helpers** (`tests/helpers.ts`): `createMockSupabase()`, `createQueuedMockSupabase()`, `createMockRequest()`, `parseJsonResponse()`, `createMockRouteParams()`, plus fixture factories (`makeTransaction`, `makeJournalEntry`, `makeInvoice`, `makeCustomer`, `makeSupplier`, `makeSupplierInvoice`, `makeFiscalPeriod`, `makeReceipt`, `makeDocumentAttachment`, `makeCompany`, `makeCompanySettings`, `makeTaxCode`, `makeSIEVoucher`, `makeBankConnection`, etc.).

**Patterns**: Always mock `@/lib/supabase/server`. `vi.clearAllMocks()` + `eventBus.clear()` in `beforeEach`. Test auth (401), validation (400), 404, 500, happy path.

**pg-real**: Parallel Vitest project for triggers/RPCs/RLS using real Postgres (CI: `supabase/postgres:15`, migrations replayed). Local: `npm run test:pg`. File convention `*.pg.test.ts`. Helpers: `tests/pg/setup.ts` (`getPool()`, `withUserContext()`), `tests/pg/fixtures.ts` (`seedCompany()`, `insertDraftJournalEntry()`, etc.). **Required**: any PR touching a trigger/RPC/RLS/DEFERRABLE must include or extend a `*.pg.test.ts`.

---

## Database & Migrations

**Location**: `supabase/migrations/` — 118 files. Early migrations use sequential numbering (`20240101000001`–`20240101000038`), later ones use real timestamps.

### Key Tables (~60)

- **Multi-tenant**: `companies`, `company_members`, `company_invitations`, `teams`, `team_members`, `team_invitations`, `user_preferences`, `profiles`
- **Bookkeeping**: `chart_of_accounts`, `fiscal_periods`, `journal_entries`, `journal_entry_lines`, `account_balances`, `voucher_sequences`, `voucher_gap_explanations`
- **Invoicing**: `customers`, `invoices`, `invoice_items`, `invoice_payments`, `invoice_inbox_items`
- **Suppliers**: `suppliers`, `supplier_invoices`, `supplier_invoice_items`
- **Banking**: `bank_connections`, `transactions`, `bank_file_imports`, `payment_match_log`
- **Documents**: `document_attachments` (WORM), `receipts`, `receipt_line_items`
- **Settings**: `company_settings`, `mapping_rules`, `categorization_templates`, `booking_template_library`, `extension_data`
- **Dimensions**: `cost_centers`, `projects`
- **Tax/Deadlines**: `tax_rates`, `tax_table_rates`, `deadlines`, `calendar_feeds`, `skatteverket_tokens`
- **API/Auth**: `api_keys`, `oauth_used_codes`, `bankid_identities`
- **Audit/Ops**: `audit_log` (immutable), `event_log` (30d TTL), `pending_operations`, `processing_history`, `ai_usage_tracking`, `automation_webhooks`
- **Inbox**: `invoice_inbox_items`, `company_inboxes`, `email_connections`
- **Salary**: `employees`, `salary_runs`, `salary_run_employees`, `salary_line_items`, `salary_payroll_config`, `agi_declarations`
- **Providers**: `provider_consents`, `provider_consent_tokens`, `provider_otc`
- **Other**: `sandbox_users`

### Key RPC Functions

- `create_company_with_owner()` — Atomic company + owner creation
- `commit_journal_entry()` — Atomic draft→posted with voucher number
- `next_voucher_number()` — Concurrent-safe voucher generation
- `detect_voucher_gaps()` — BFNAR 2013:2 gap detection
- `generate_invoice_number()`, `get_next_arrival_number()`, `generate_delivery_note_number()` — Sequence generators
- `seed_chart_of_accounts()` — BAS chart seeding per entity type
- `validate_and_increment_api_key()` — Atomic rate limiting
- `user_company_ids()` — RLS helper returning user's company IDs
- `get_unlinked_1930_lines()` — Bank reconciliation helper
- `cleanup_sandbox_user()`, `cleanup_expired_sandbox_users()` — Sandbox lifecycle

### Key Triggers

- `check_journal_entry_balance()` — Debit must equal credit
- `enforce_journal_entry_immutability()` — Posted entries cannot be modified
- `enforce_period_lock()` — No entries in closed/locked periods
- `enforce_company_lock_date()` — Company-wide bookkeeping lock date
- `block_document_deletion()` — WORM compliance
- `enforce_retention_journal_entries()` — 7-year retention
- `audit_log_immutable()` — Audit log cannot be modified
- `write_audit_log()` — Auto-audit on DML operations
- `sync_team_member_to_companies()` — Auto-sync team→company membership

### Migration Rules

1. Enable RLS + policies using `user_company_ids()` for company-scoped data
2. Add `updated_at` trigger via `update_updated_at_column()`
3. UUID PKs: `DEFAULT uuid_generate_v4()`
4. Company ownership: `company_id UUID REFERENCES companies NOT NULL` + `user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL`
5. Never modify existing migrations — create new ones
6. Never modify enforcement triggers (migration 017) — legally required
7. Apply via Supabase MCP `apply_migration`
8. Always end with `NOTIFY pgrst, 'reload schema'` when altering table structure

**Agent skill bodies (`agent_atom_registry`)**: skill content is authored in `.claude/skills/**/SKILL.md` and inlined into the DB `body` column at runtime (not read from disk — that doesn't bundle on Vercel/Docker). After editing any SKILL.md, run `npm run skills:generate` to emit a new `*_seed_agent_atom_bodies.sql` migration and commit it; `npm run skills:check` (wired into CI) fails the build if you forget. The MCP server exposes only atoms with `mcp_exposed = true` (swarm-* audit skills are never atoms).

---

## Skills, Git & CI

**Skills**: Always use `/frontend-design` for new UI. Use `vercel:deploy` for deployment. Use `/supabase-migration` for new migrations. Use `/erp-api-route` for new API routes. Use `/create-extension` for new extensions. Use the Swedish domain skills (`swedish-sie-import-export`, `swedish-accounting-compliance`, `swedish-vat`, `swedish-invoice-compliance`, `swedish-payroll`, `swedish-year-end-closing`, `swedish-financial-reporting`, `swedish-sru-filing`, `swedish-asset-accounting`, `swedish-project-accounting`, `swedish-tax-planning`) for accounting domain questions.

**Git**: Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Atomic commits, branch from `main`.

**CI**:
- `.github/workflows/core-build.yml` — resets extensions to empty, runs build + test, verifies no core code imports from `@/extensions/` directly.
- `.github/workflows/swedish-compliance-review.yml` — Swedish accounting compliance review on PRs touching bookkeeping/reports/tax logic.
- `.github/workflows/docker-publish.yml` — pushes images to GHCR on main.

**Docker** (`.github/workflows/docker-publish.yml`): Pushes to GHCR (`erp-mafia/erp-base`) on main push. 4-stage Dockerfile (base → deps → builder → runner) with Node 22 Alpine. Runtime env placeholder replacement via `docker-entrypoint.sh`. Docker Compose with app + supercronic cron service.

---

## Deployment

### Vercel (Hosted)

Cron jobs in `vercel.json`: deadline status (`6:00`), invoice reminders (`8:00`), tax deadlines (yearly Jan 2), enable-banking sync (`5:00`), document verify (`3:00`), sandbox cleanup (`4:00`), event log cleanup (`2:00`, 30-day TTL), cloud-backup auto-sync (hourly).

### Docker (Self-Hosted)

- `Dockerfile`: 4-stage Node 22 Alpine build with standalone output
- `docker-compose.yml`: App service + supercronic cron scheduler
- `docker-entrypoint.sh`: Validates required env vars, replaces build-time placeholders in `.next/static/` JS
- Extension presets: `docker/extensions.self-hosted.json`, `docker/extensions.hosted.json`

### Environment Variables

**Required**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`, `CRON_SECRET`

**Auth**: `NEXT_PUBLIC_REQUIRE_MFA` (set `true` on hosted), `NEXT_PUBLIC_SELF_HOSTED` (set `true` for Docker)

**Extension-specific** (only when extension is enabled): `ENABLE_BANKING_APP_ID`/`ENABLE_BANKING_APP_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `RESEND_API_KEY`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`

**Optional**: `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`

## Other
Never create a NUL/nul file: \gnubok\NUL

---

## i18n

The app is Swedish-first and bilingual (Swedish + English) for UI chrome. Locale is per-user on `user_preferences.locale` (`'sv' | 'en'`, default `'sv'`), resolved server-side via next-intl. The user picker lives at `/settings/account`.

**Pattern for new UI:**

```tsx
// Server component
import { getTranslations } from 'next-intl/server'
const t = await getTranslations('namespace')

// Client component
'use client'
import { useTranslations } from 'next-intl'
const t = useTranslations('namespace')

// In JSX
<button>{t('save')}</button>
```

Add new strings to both `messages/sv.json` and `messages/en.json` under the matching namespace (`common`, `nav`, `auth`, `settings`, `empty`, etc.). Never ship an English key without a Swedish counterpart — Swedish is the default and the fallback.

**Locale-aware formatters:**
- `formatCurrency(amount)` — stays SEK with sv-SE conventions in BOTH locales (Swedish accounting standard, not a UI string).
- `formatDate(date)` — ISO `yyyy-MM-dd`, locale-independent.
- `formatDateLong(date, locale)` — accepts locale. In client components use `useFormat()` (`lib/hooks/use-format.ts`) which pulls the active locale.

**Error messages:** `getErrorMessage(err, { locale, context })` from `lib/errors/get-error-message.ts` is bilingual on the primary maps (Postgres codes, HTTP statuses, context fallbacks, generic fallback). The structured error envelope (`{ error: { code, message, message_en } }`) already carries both; the function picks the right one from `locale`. Pass `useLocale()` / `getLocale()` as the locale arg.

**Stays Swedish — do NOT translate:**

| Surface | Reason |
|---|---|
| Invoice PDFs (`lib/invoices/pdf-template.tsx`) | Customer-facing — driven by `customer.language` (`sv` default, `en` opt-in). The template's chrome translates; statutory chapter refs (ML 17 kap 24§, ML 3 kap.) stay intact in both locales. |
| Customer email templates (`lib/email/invoice-templates.ts`, `reminder-templates.ts`) | Same — `customer.language` drives the output. `reminder-templates.ts` is still Swedish-only; mirror the PDF/invoice-templates approach if you add English here. |
| Year-end wizard (`app/(dashboard)/bookkeeping/year-end/page.tsx`) | Statutory bokslut terminology; English would be misleading |
| Journal entry editor (`app/(dashboard)/bookkeeping/[id]/page.tsx`) | Deeply regulatory (verifikat, voucher numbers, BAS) |
| INK2 / NE-bilaga / SRU (`lib/reports/ink2/**`, `lib/reports/ne-bilaga/**`, `lib/reports/sru-*`) | Skatteverket forms — field codes and labels are statutory |
| SIE export (`lib/reports/sie-export.ts`) | SIE format is Swedish-only by spec (#KONTO, #VER, etc.) |
| BAS chart names (`lib/bookkeeping/bas-data/**`) | Standardized Swedish account names per BAS 2026 |
| VAT declaration ruta labels (`lib/reports/vat-declaration*.ts`) | Momsdeklaration field labels are Skatteverket form labels |
| Salary AGI / KU (`lib/salary/agi*`, `lib/salary/ku*`) | Skatteverket-bound forms |
| Bookkeeping engine domain errors ("Verifikationen balanserar inte", "Bokföringen är låst") | Regulatory concepts; English equivalents would be ambiguous |

Anything in the table above stays Swedish in BOTH locales. If you find yourself reaching for `t()` inside one of these files, stop and reconsider.

---

## Design Context

### Users

Swedish sole traders (enskild firma) and small business owners (aktiebolag) who need to manage their own bookkeeping. They are not accountants — they are professionals (consultants, freelancers, shop owners) who want to stay compliant without hiring one. They use gnubok in short, focused sessions: sending an invoice, categorizing bank transactions, filing a VAT declaration. Speed and clarity matter — every second spent in the app is a second away from their real work.

### Brand & Aesthetic

**Editorial monochrome.** Paper-white surfaces, hairline borders, serif headlines. The interface should feel like a well-made instrument — considered, quiet, confident. Anti-references: enterprise software (SAP/Oracle density), neon SaaS coldness.

- **Palette**: Achromatic foundation. Pure white background, warm beige (`40 11% 89%`) for chips / active sidebar / hover / secondary buttons. Achromatic primary (no cool tint). Semantic colors (`--success` sage, `--warning` ochre, `--destructive` terracotta) exist but are **data-only** — they appear in charts and financial numbers (positive/negative deltas), never as chrome backgrounds. In chrome, only `--destructive` survives.
- **Typography**: Hedvig Letters Serif for display headings, Geist (sans) for body, forms, and tables. Hedvig is single-weight (400) — do not apply `font-medium` to display text; its natural high-contrast strokes carry the weight. Tabular numbers everywhere financial data appears.
- **Surfaces**: Cards sit flat on the page — no shadow, full-opacity hairline border (`border-border`), `rounded-lg` (8px). Card background matches page background; the border carries hierarchy. Dark mode drops the warm tint from secondary for a pure-gray mood shift; light mode keeps the beige.
- **Spacing**: Generous whitespace. Dense data (tables, ledgers) uses tighter spacing but never feels cramped.
- **Motion**: Functional, not decorative. No press-scale, no hover-lift, no spring overshoot. Hover state is a flat background shift (`bg-secondary/60`). `transition-colors duration-150` is the default. Stagger animations on list entry are fine. Respect `prefers-reduced-motion` (already wired).
- **Icons**: Lucide — 15px in navigation, slightly larger in empty states.

### Design Principles

1. Clarity over cleverness — Swedish labels, obvious hierarchy.
2. Earned minimalism — remove what doesn't serve the task, keep compliance context.
3. Numbers are first-class — tabular-nums, alignment, positive/negative clarity.
4. Trust through consistency.
5. Speed is a feature — optimize for the 90-second session.

### Accessibility

WCAG AA (4.5:1 text, 3:1 UI). Keyboard-navigable + visible focus rings. Respect `prefers-reduced-motion`. Color never sole state indicator. Touch targets ≥40px (44px for mobile-critical). Icon-only buttons need `aria-label`.

### Design System Tokens

These conventions are locked. Don't reinvent them in new code; deviating from them on existing pages is a regression.

**Spacing scale.** Only use Tailwind values `1, 2, 3, 4, 6, 8, 10, 12`. **Forbidden:** `2.5`, `5`, hardcoded pixels in page logic.

| Token | Tailwind | Use for |
|---|---|---|
| 4 | `1` | icon padding |
| 8 | `2` | tight inline gaps |
| 12 | `3` | dense list rows, badge gaps |
| 16 | `4` | default form / control / grid gap |
| 24 | `6` | **card padding default** (`p-6`) |
| 32 | `8` | **between page sections** (`space-y-8` on page root) |
| 40 | `10` | hero spacing |
| 48 | `12` | top of page after header |

Compact metric cards (e.g. dashboard tiles, salary KPI row) use `p-4`. Detail cards use `p-6`. Never mix `p-5`.

**Layout.**
- Sidebar width: `md:w-64` (256px). Main content offset: `md:pl-64`.
- Main container: `max-w-5xl mx-auto px-5 py-8 md:px-8 md:py-10` (via `components/dashboard/MainContainer.tsx`).
- Page root: `<div className="space-y-8">`.

**Primitives — always use these, don't hand-roll.**

| Need | Component | Notes |
|---|---|---|
| Page title + action | `components/ui/page-header.tsx` `PageHeader` | Use this, not bespoke `<h1>` + `<p>` blocks. Drop the `description` prop when it just paraphrases the title. |
| Data table | `components/ui/table.tsx` `Table / TableHeader / TableHead / TableRow / TableCell` | Header style is baked in: `text-[11px] font-medium uppercase tracking-wider text-muted-foreground`. Wrap in `<CardContent className="p-0">` when the table is a card's primary content. Add `tabular-nums` to numeric cells. |
| Status indicator | `components/ui/badge.tsx` `<Badge variant>` | Variants: `default / secondary / success / warning / destructive / outline`. **Never** use raw Tailwind colors (`bg-blue-100`, `bg-emerald-500/10`, etc.) for status. Map status → variant via a small `Record` per feature. |
| No-data state | `components/ui/empty-state.tsx` `EmptyState` | Don't hand-roll `<div className="flex flex-col items-center py-12">…</div>`. Preset variants exist (`EmptyInvoices`, `EmptyCustomers`, `EmptyTransactions`, etc.). |
| Loading placeholder | `components/ui/skeleton.tsx` `<Skeleton>` | Don't hand-roll `bg-muted rounded animate-pulse` divs. |
| Inline help / formulas | `components/ui/info-tooltip.tsx` `InfoTooltip` | Hover-revealed; don't use always-visible info buttons. |
| Fiscal year picker | `components/common/FiscalYearSelector.tsx` | Don't use raw `<select>` for fiscal periods. |

**Tabular display rules.**
- All financial values get `tabular-nums`.
- Dates in tables: `tabular-nums` for fixed width.
- Right-align numeric columns (`text-right`).
- For group bands inside tables (Resultatrapport-style): `<tr className="bg-muted/30"><td colSpan={n} className="px-4 py-2 text-[12px] font-semibold text-muted-foreground">{label}</td></tr>`.

**Date formatting.** Two helpers in `lib/utils.ts`:
- `formatDate(x)` → `2026-05-11` (ISO `yyyy-MM-dd`). Use for accounting data — transaction dates, invoice dates, payment dates, voucher dates. Aligns in tables, matches SIE/BFL convention.
- `formatDateLong(x)` → `11 maj 2026` (Swedish long form). Use for metadata — when something was created, linked, verified, expires. Settings panels and audit displays.

Never render raw `{x.invoice_date}` directly — always route through `formatDate()` for code consistency.

**Currency.** `formatCurrency(n, currency?)` from `lib/utils.ts`. Default SEK.

**Typography.**
- Page title: use `PageHeader` (renders `font-display text-3xl md:text-4xl tracking-tight`). Do not hand-roll an `<h1>`.
- Card title: `<CardTitle className="text-base">` for sections, default for primary cards. The primitive already drops `font-medium` — do not add it back.
- Section divider header inside a page: `<h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">`.
- Headline number: `font-display text-xl tabular-nums`. No `font-medium` — Hedvig's natural weight carries the gravitas.
- Display font (`font-display`, Hedvig Letters Serif) reserved for h1/h2/h3 and primary financial numbers. If a specific `font-display` numeral reads weak inside a compact metric card, override that call site with `font-sans tabular-nums` (Geist) — better legibility on small numerals.

**Forbidden / dead patterns.**
- Page descriptions that paraphrase the page title (e.g. `<PageHeader title="Fakturor" description="Hantera dina fakturor">`) → drop the description.
- Two different status indicators on the same element (e.g. colored card border *and* Badge for status) → pick one (prefer Badge).
- Mobile-specific `<select>` duplicating desktop tabs in code — use a single Tabs primitive or a single grouped `Select`.
- Hand-rolled icon buttons smaller than `h-10 w-10`. Use shadcn `Button size="icon"`.
- Color-coded status using full-rainbow Tailwind palette (`bg-amber-100`, `bg-emerald-500/10`, etc.). Use Badge variants tied to the brand palette.
- `shadow-sm` / `shadow-md` / `shadow-lg` on cards, buttons, or list items. The aesthetic is flat-with-hairlines — surfaces use `border-border`, not elevation. Shadows survive only on dialogs/popovers/dropdowns (anything that overlays the page).
- `active:scale-[...]` on buttons. Buttons do not bounce.
- `bg-gradient-to-*` on page or card backgrounds. Flat surfaces only.
- `font-medium` on display elements (`font-display`, h1/h2/h3, CardTitle, PageHeader title). Hedvig is single-weight by design.
- `rounded-xl` (12px) on cards. Cards are `rounded-lg` (8px). `rounded-xl` survives only on prominent hero-style surfaces if absolutely needed.
- Opacity-suffixed border classes (`border-border/30`, `border-border/60`) on cards and primary surfaces. Use full-opacity `border-border` — the new border token is calibrated for that.
