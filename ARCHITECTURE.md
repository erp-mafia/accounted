# Architecture

Accounted is a multi-tenant double-entry bookkeeping system built for Swedish
accounting law. This document explains how the system is put together and why
some parts are deliberately rigid. For contribution workflow, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Overview

- **Framework**: Next.js (App Router) with React and TypeScript in strict mode.
- **Database**: Supabase (PostgreSQL with Row Level Security), which also
  provides auth (email/password plus TOTP MFA).
- **Deployment**: Vercel-hosted is the primary target; a Docker self-hosted
  setup is fully supported (see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)).
- **UI**: Tailwind CSS with shadcn/ui components. User-facing product language
  is Swedish and English (`messages/sv.json`, `messages/en.json`).

## The bookkeeping engine

All accounting writes flow through one engine: `lib/bookkeeping/engine.ts`.

The journal entry lifecycle is draft, then commit:

1. `createDraftEntry()` creates an uncommitted entry that can still change.
2. `commitEntry()` posts it. The voucher number is assigned atomically by the
   `commit_journal_entry` database RPC, which keeps numbering sequential per
   series. Swedish law requires an unbroken, explainable voucher sequence.
3. `createJournalEntry()` does both steps in one call.

Two invariants hold for every entry:

- Debits equal credits, and both sides are greater than zero.
- Once committed, an entry is never silently edited or deleted. BFL 5 kap.
  5 § allows two correction paths, and the code has exactly those two:
  - Storno: `reverseEntry()` cancels a voucher with a reversal entry and
    `correctEntry()` replaces it (`lib/core/bookkeeping/storno-service.ts`).
    Always allowed.
  - Inline rättelse (founder-approved 2026-07-23): the
    `correct_entry_metadata` and `correct_entry_lines_inline` RPCs
    strike-and-replace inside the same voucher, keeping the original
    readable and writing an immutable who/when record to
    `journal_entry_rattelse_log`. Only while the period is open and
    unlocked; past a lock, close, or declared state, storno is the only path.

If a gap still occurs in a voucher series (for example around imported
history), it must be documented, and the explanation is stored
(`voucher_gap_explanations`), following BFNAR 2013:2.

## Legal enforcement lives in the database

The rules above are not conventions; they are enforced by PostgreSQL triggers:

- Committed journal entries cannot be edited or deleted. The only changes the
  triggers permit are the controlled status transition used by the storno flow
  (marking an entry as reversed) and the audited inline-rättelse RPCs above,
  which are refused once the period is locked or closed.
- Writes to closed or locked accounting periods are rejected, as are writes
  behind a company-wide lock date.
- Documents linked to posted entries cannot be deleted; Swedish law requires
  7-year retention of accounting records.

Application code never works around these triggers. If a code path hits one,
the code path is wrong, not the trigger.

Two smaller invariants that show up everywhere in the codebase:

- Monetary amounts are rounded with `Math.round(x * 100) / 100`. String-based
  rounding such as `toFixed()` causes drift at the öre level and breaks entry
  balance.
- Account numbers are strings (`'1930'`, never `1930`). They are identifiers,
  not quantities.

## Multi-tenancy and security

Users belong to companies through `company_members`, and every business table
carries a `company_id`. Access control is layered:

- **Row Level Security** in PostgreSQL restricts rows to companies the user
  belongs to.
- **Explicit filtering**: queries still filter by `company_id` in code, as
  defense in depth, because service-role code paths bypass RLS.
- **Route guards**: API routes wrap a shared route context helper that
  resolves the authenticated user, the active company, and MFA enforcement in
  one place. Routes never hand-roll their own auth.

The active company is resolved server-side from the user's stored preference,
so the Next.js app and RLS always agree on which company is active.

## Extension system

Core is a complete accounting product on its own. Optional functionality
(AI categorization, receipt OCR, email, calendar, the MCP server, and more)
ships as extensions under `extensions/`, toggled by `extensions.config.json`.

The boundary is strict and CI-enforced:

- Core code never imports from `@/extensions/`. CI builds core with zero
  extensions enabled, so a direct import breaks the build.
- Extensions integrate through the event bus and documented extension APIs,
  and are wired via a generated static registry (`npm run setup:extensions`).

Licensing follows the same boundary: the project is AGPL-3.0, with an
extension exception that allows third-party extensions using only the
documented Extension API to be licensed under any terms. See
[LICENSE](LICENSE) and [docs/EXTENSIONS.md](docs/EXTENSIONS.md).

## Agent surface (MCP)

The bookkeeping engine is exposed as an MCP (Model Context Protocol) server
with 150+ tools, so AI agents can operate the ledger: list and categorize
transactions, draft vouchers, reconcile periods, generate reports and
declarations.

- Authentication uses scoped API keys (stored as SHA-256 hashes, rate limited
  per key). Claude and ChatGPT connectors instead authenticate with OAuth 2.1
  (PKCE; `app/api/mcp-oauth/{authorize,register,token}` plus the
  `.well-known` discovery documents), which mints a scoped API key behind the
  scenes. Authentication is lazy: a client can connect, list tools, and call a
  small set of public discovery tools before an account exists; the first
  tenant-touching call answers 401 and triggers the client's connect prompt
  (`extensions/general/mcp-server/public-tools.ts`).
- Posting operations are staged: an agent proposes an operation, and a human
  approves it before anything is committed to the journal.

## Events

`lib/events/bus.ts` is a module-level singleton event bus. Domain events (for
example "invoice created" or "transaction imported") are how extensions react
to core activity without core knowing about them.

## Repository map

| Path | Contents |
|---|---|
| `app/` | Next.js App Router pages and API routes |
| `lib/bookkeeping/` | Engine, entry generators, account mapping, BAS chart data |
| `lib/core/` | Periods, year-end, storno, tax codes, audit, documents |
| `lib/reports/` | Balance sheet, income statement, VAT, SIE, tax reports |
| `lib/` (other) | Invoices, transactions, imports, salary, reconciliation, tax, providers |
| `components/` | React components (shadcn/ui based) |
| `extensions/` | Opt-in extension plugins |
| `supabase/migrations/` | Database schema, RLS policies, enforcement triggers |
| `packages/accounted-mcp` | Published stdio MCP bridge for new installs (`accounted_*` tool namespace) |
| `packages/gnubok-mcp` | Compatibility MCP bridge for existing installs (kept on purpose) |
| `claude-plugin/` | Claude Code plugin: OAuth connector plus approval-gated workflow skills |
| `messages/` | Swedish and English UI strings |
| `tests/` | Shared test helpers and fixtures |
| `docs/` | Self-hosting, Docker, extensions, white-label guides |

## Testing

- Unit and route tests run on Vitest with mocked Supabase clients
  (`npm test`).
- Database behavior (triggers, RPCs, RLS) is tested against a real PostgreSQL
  instance in `*.pg.test.ts` files (`npm run test:pg`), because mocking cannot
  prove trigger semantics.
