---
paths:
  - "supabase/migrations/**"
  - "tests/pg/**"
---

# Database & Migrations

Use the `/supabase-migration` skill for new migrations.

**Location**: `supabase/migrations/`: 330+ files. Early migrations use sequential numbering (`20240101000001`-`20240101000038`), later ones use real timestamps.

## Migration Rules

1. Enable RLS + policies using `user_company_ids()` for company-scoped data
2. Add `updated_at` trigger via `update_updated_at_column()`
3. UUID PKs: `DEFAULT uuid_generate_v4()`
4. Company ownership: `company_id UUID REFERENCES companies NOT NULL` + `user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL`
5. Never modify existing migrations: create new ones
6. Never modify enforcement triggers (migration 017), legally required
7. Apply via Supabase MCP `apply_migration`
8. Always end with `NOTIFY pgrst, 'reload schema'` when altering table structure

**pg-real tests**: any PR touching a trigger/RPC/RLS/DEFERRABLE must include or extend a `*.pg.test.ts`. Parallel Vitest project against real Postgres (CI: `supabase/postgres:15`, migrations replayed). Local: `npm run test:pg`. Helpers: `tests/pg/setup.ts` (`getPool()`, `withUserContext()`), `tests/pg/fixtures.ts` (`seedCompany()`, `insertDraftJournalEntry()`, etc.).

## Key Tables (~60)

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
- **Agent**: `agent_atom_registry` (inlined skill bodies, see below)
- **Other**: `sandbox_users`

## Key RPC Functions

- `create_company_with_owner()`: Atomic company + owner creation
- `commit_journal_entry()`: Atomic draft→posted with voucher number
- `next_voucher_number()`: Concurrent-safe voucher generation
- `detect_voucher_gaps()`: BFNAR 2013:2 gap detection
- `generate_invoice_number()`, `get_next_arrival_number()`, `generate_delivery_note_number()`: Sequence generators
- `seed_chart_of_accounts()`: BAS chart seeding per entity type
- `validate_and_increment_api_key()`: Atomic rate limiting
- `user_company_ids()`: RLS helper returning user's company IDs
- `get_unlinked_1930_lines()`: Bank reconciliation helper
- `cleanup_sandbox_user()`, `cleanup_expired_sandbox_users()`: Sandbox lifecycle

## Key Triggers

- `check_journal_entry_balance()`: Debit must equal credit
- `enforce_journal_entry_immutability()`: Posted entries cannot be modified
- `enforce_period_lock()`: No entries in closed/locked periods
- `enforce_company_lock_date()`: Company-wide bookkeeping lock date
- `block_document_deletion()`: WORM compliance
- `enforce_retention_journal_entries()`: 7-year retention
- `audit_log_immutable()`: Audit log cannot be modified
- `write_audit_log()`: Auto-audit on DML operations
- `sync_team_member_to_companies()`: Auto-sync team→company membership

## Agent skill bodies (`agent_atom_registry`)

Skill content is authored in `.claude/skills/**/SKILL.md` and inlined into the DB `body` column at runtime (not read from disk: that doesn't bundle on Vercel/Docker). After editing any atom SKILL.md, run `npm run skills:generate` to emit a new `*_seed_agent_atom_bodies.sql` migration and commit it; `npm run skills:check` (wired into CI) fails the build if you forget. Only the curated tiers become atoms: `swedish-*` (horizontal), `industry/<slug>` (vertical), `modifier/<slug>` (modifier); other Claude Code skills never become atoms. The MCP server exposes only atoms with `mcp_exposed = true`.
