# AGENTS – Ømbra integration (Books)

Agent mandate for the **Books side** of the Ømbra sidecar. Books is **open source** under `public/books/`; **Ombra product UI** lives in `apps/ombra/` + `packages/ui/`; **BFF and secrets** in `career/`. Backend consumes Books via HTTP — not by importing `lib/` into JobSync or `apps/ombra`.

Read `[ARCHITECTURE.md](./ARCHITECTURE.md)` before code changes. Monorepo context: `[../../../../ARCHITECTURE.md](../../../../ARCHITECTURE.md)`, `[../../../../AGENTS.md](../../../../AGENTS.md)`. Path-scoped rules load from `[.claude/rules/ombra-integration.md](../../.claude/rules/ombra-integration.md)`. Core product rules remain in `[CLAUDE.md](../../CLAUDE.md)`.

---

## 1. Scope

This document applies **only** to:

- `app/api/integrations/ombra/**`
- `lib/integrations/ombra/**`
- Hybrid publish / OBX trust docs under `docs/ombra/obx-trust.md`

It does **not** replace `CLAUDE.md` for core accounting, dashboard, MCP, or extensions.

---

## 2. Agent role

The integration agent:

- Implements a **thin HTTP API** consumed by Career / Ømbra BFF (`books-client.ts`)
- Delegates all journal mutations to `lib/bookkeeping/engine.ts` and existing domain services
- Keeps Ømbra-specific logic out of the bookkeeping engine and core dashboard
- Updates this doc and `ARCHITECTURE.md` when flows or endpoints change

The integration agent does **not**:

- Modify `lib/bookkeeping/engine.ts`, entry generators, or accounting guard rails for Ømbra
- Insert or update journal tables directly
- Add career/CV/JobSync data to Books Supabase
- Build Ømbra UI (that lives in `apps/ombra/` and `packages/ui/` — **not** in Books dashboard)

---

## 3. Product boundary

**Ømbra (apps/ombra + jobsync BFF)** — human-in-the-loop for sole traders and small businesses:

- Invoice inbox `@invoice.ombra-apt.com`
- Draft review and approval in `/company/{slug}`
- Reports and SIE export in Ømbra chrome

**Books** — system of record (hosted / hybrid after publish):

- Companies, chart of accounts, journal entries, VAT, documents
- API keys, RLS, fiscal periods, compliance triggers
- Hybrid: self-host workshop publishes OBX year-seal to hosted SoR ([ADR 013](../../../../docs/adr/013-hosted-canonical-ledger.md))

End users on `app.ombra-apt.com` should not need Books branding for day-to-day company tasks.

---

## 4. Critical rules (never violate)

1. **Engine only** — `createDraftEntry()` → `commitEntry()`, or `createJournalEntry()`; reversals via `reverseEntry()` / `correctEntry()`
2. **No direct journal writes** — no raw inserts into `journal_entries` / `journal_lines`
3. **No engine changes for Ømbra** — extend via `app/api/integrations/ombra/` and `lib/integrations/ombra/`
4. **Contract sync** — new endpoints must be added in both Books and `books-client.ts` (jobsync)
5. **Company scope** — every query filters by `company_id`; API key auth via `lib/auth/api-keys.ts`
6. **Hybrid publish** — year-seal only; no live journal replication

---

## 5. Implementation status (2026-07)

**Implemented (sidecar):**

- Routes under `/api/integrations/ombra/*` (companies, drafts, documents, reports, SIE, OBX export/import/transfer, …)
- Service layer `lib/integrations/ombra/*`
- Hybrid publish helpers + pre-publish checklist (`lib/obx/publish-*`) when `OMBRA_LEDGER_MODE=hybrid`

**Phased:**

- OBX escrow / `keys@` mail attest ([ADR 014](../../../../docs/adr/014-obx-trust-anchor.md)) — registry/verify sidecar is live; escrow is not

**Exists in jobsync (client):**

- `books-client.ts` with stub fallback when Books env unset
- UI: `/company/{slug}/inbox`, `/reports`, `/export`

---

## 6. Priorities

1. Keep sidecar contract green (provision, drafts approve/reject, reports, SIE)
2. Hybrid OBX publish (self-host → hosted SoR)
3. Registry/verify attest (after publish MVP)
4. Bank PSD2 and advanced automation remain secondary

---

## 7. Testing

- Unit tests in `__tests__/lib/integrations/ombra/` and `__tests__/app/api/integrations/ombra/`
- Mock engine; never bypass engine in tests that assert posting behaviour
- Any trigger/RPC/RLS touch requires `*.pg.test.ts` per `.claude/rules/database.md`
- Contract tests: request/response shapes match `books-client.ts` types

---

## 8. Cross-repo documentation

**Jobsync (Ømbra product):**

- `processer/bolagstjanster/agents.md`
- `processer/bolagstjanster/integrationsplan-books.md`
- `processer/bolagstjanster/databas-avgransning.md`
- `src/lib/company-services/books-client.ts`

**Books (this repo):**

- `docs/ombra/AGENTS.md` (this file)
- `docs/ombra/ARCHITECTURE.md`
- `docs/ombra/obx-trust.md`
- `.claude/rules/ombra-integration.md`
- `corporate/vision/hosted-huvudbok.md`

---

## 9. Skills and rules

- `/erp-api-route` — scaffold API routes
- `.claude/rules/api-routes.md` — `withRouteContext`, validation, auth
- `.claude/rules/bookkeeping.md` — BAS, VAT, engine usage (read-only for integration work)
- `.claude/rules/database.md` — migrations, RLS, pg-real tests
- Swedish domain skills when touching VAT or compliance surfaces
