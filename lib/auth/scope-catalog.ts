/**
 * API-key scope catalogue: scope ids, labels, groups and the MCP tool map.
 *
 * Pure data with no server imports, so client components (the settings
 * panel) can bundle it without dragging in crypto or the service-role
 * Supabase client that lib/auth/api-keys.ts needs. api-keys.ts re-exports
 * everything here; server code keeps importing from there.
 */

// ── API Key Scopes ──────────────────────────────────────────

export const API_KEY_SCOPES = {
  'transactions:read':  { label: 'Transaktioner: läs',  description: 'Lista transaktioner, mallförslag, kategoriförslag' },
  'transactions:write': { label: 'Transaktioner: skriv', description: 'Kategorisera, av-kategorisera, kvittomatchning, koppling mot faktura' },
  'customers:read':     { label: 'Kunder: läs',         description: 'Lista kunder' },
  'customers:write':    { label: 'Kunder: skriv',       description: 'Skapa och uppdatera kunder' },
  'articles:read':      { label: 'Artiklar: läs',       description: 'Lista artiklar i artikelregistret' },
  'articles:write':     { label: 'Artiklar: skriv',     description: 'Skapa och uppdatera artiklar' },
  'invoices:read':      { label: 'Fakturor: läs',       description: 'Lista fakturor' },
  'invoices:write':     { label: 'Fakturor: skriv',     description: 'Skapa, skicka, markera betald/skickad' },
  'suppliers:read':     { label: 'Leverantörer: läs',   description: 'Lista leverantörer och leverantörsfakturor, hitta verifikat-kandidater' },
  'suppliers:write':    { label: 'Leverantörer: skriv', description: 'Skapa leverantörer; godkänn, kreditera, betal-länka och hantera leverantörsfakturor' },
  'reports:read':       { label: 'Rapporter: läs',      description: 'Kontoplan, huvudbok, balansräkning, resultaträkning, moms, KPI, reskontra, perioder, bankavstämning, SIE-export' },
  'bookkeeping:write':  { label: 'Bokföring: skriv',    description: 'Stänga/låsa perioder, ingående balans, bokslut, SIE-import, voucher-gap-förklaringar, kontoplan (skapa/ändra konton), verifikat-anteckningar' },
  'payroll:read':       { label: 'Löner: läs',          description: 'Lista anställda, lönekörningar, lönejournal, körjournal' },
  'payroll:write':      { label: 'Löner: skriv',        description: 'Skapa lönekörning, beräkna, generera AGI, logga körjournalresor' },
  // v1 REST API: added Phase 1
  'companies:read':     { label: 'Företag: läs',        description: 'Lista och visa företagsprofiler som API-nyckeln har tillgång till' },
  'companies:write':    { label: 'Företag: skriv',      description: 'Skapa nya företag och uppdatera företagsinställningar (gnubok_create_company, stagade verktyg, REST POST /api/v1/companies och PATCH /api/v1/companies/{companyId}/settings)' },
  'events:read':        { label: 'Händelser: läs',      description: 'Polla händelseloggen (event_log) som webhook-fallback' },
  'webhooks:manage':    { label: 'Webhooks: hantera',   description: 'Skapa, lista, uppdatera och radera webhook-prenumerationer' },
  'operations:read':    { label: 'Operationer: läs',    description: 'Hämta status för långkörande operationer (importer, bokslut, omvärdering)' },
  'documents:read':     { label: 'Dokument: läs',       description: 'Lista och hämta dokumentbilagor' },
  'documents:write':    { label: 'Dokument: skriv',     description: 'Ladda upp och koppla dokument till verifikationer' },
  'compliance:read':    { label: 'Compliance: läs',     description: 'Pre-flight-kontroller: momsstängning, bokslutsberedskap, voucher-gap, IB/UB-kontinuitet; Skatteverket-status (moms + AGI)' },
  'skatteverket:write': { label: 'Skatteverket: skriv', description: 'Lämna momsdeklaration och arbetsgivardeklaration (AGI) till Skatteverket (stagas; signeras med BankID)' },
  'agent:read':         { label: 'Agent: läs',          description: 'Specialiserad bokföringsassistent: profil, laddade specialister/atomer, minnen (briefing + skill-katalog)' },
  'agent:write':        { label: 'Agent: skriv',        description: 'Spara och ta bort agentens minnen om företaget (remember_fact, forget_fact)' },
  'pending_operations:read':    { label: 'Stagade operationer: läs',     description: 'Lista pending_operations (staged writes awaiting approval)' },
  'pending_operations:approve': { label: 'Stagade operationer: godkänn', description: 'Godkänn eller avvisa stagade operationer via API/MCP: agenten ersätter web-UI:s granskning' },
  // Reconciliation (account-keyed: bank accounts + skattekonto). Reads cover
  // the account list, the bridge and the item buckets; writes cover links
  // (match/unmatch) and ignore flags. Links never touch the ledger.
  'reconciliation:read':  { label: 'Avstämning: läs',   description: 'Konton att stämma av, bryggan per konto och raderna bakom den (bank + skattekonto)' },
  'reconciliation:write': { label: 'Avstämning: skriv', description: 'Koppla och koppla bort händelser mot verifikat, ignorera rader (MCP stagar; REST skriver direkt)' },
  'reconciliation:signoff': { label: 'Avstämning: signera', description: 'Markera ett konto som avstämt t.o.m. ett datum och öppna en signering igen (MCP stagar; REST skriver direkt)' },
} as const

export type ApiKeyScope = keyof typeof API_KEY_SCOPES

export const ALL_SCOPES: ApiKeyScope[] = Object.keys(API_KEY_SCOPES) as ApiKeyScope[]

/** The read-only scopes assigned to keys with no explicit scopes (legacy/null). */
export const DEFAULT_SCOPES: ApiKeyScope[] = [
  'transactions:read',
  'customers:read',
  'articles:read',
  'invoices:read',
  'suppliers:read',
  'reports:read',
]

/**
 * Default scope grant for OAuth-issued keys when the client did not pass an
 * explicit `scope` parameter at /authorize. Read-only by design: every
 * write or approval scope must be requested explicitly by the client AND
 * affirmatively ticked by the user on the consent screen.
 *
 * Rationale (do not weaken without a documented security decision):
 *   - GDPR Art. 25(2) data-protection-by-default: the minimum-necessary
 *     access set must be the silent baseline.
 *   - ISO 27001:2022 A.5.18 / A.8.2 / SOC 2 CC6.3: privileged capabilities
 *     (write, approve) must not be bundled into a default grant.
 *   - Segregation of Duties (findStageApproveConflict below): granting any
 *     STAGING_SCOPES member together with `pending_operations:approve` on a
 *     single key lets an automated agent both stage AND commit financial
 *     postings without a human-in-the-loop review. Keeping the default
 *     read-only prevents this combination from being silently issued.
 *   - BFL 5 kap 5§ / BFNAR 2013:2 behandlingshistorik: write paths that
 *     create or modify verifikationer must be opt-in at the authorization
 *     layer; conversational acknowledgement at the agent layer is not an
 *     auditable substitute.
 */
export const DEFAULT_OAUTH_SCOPES: ApiKeyScope[] = [
  'transactions:read',
  'customers:read',
  'articles:read',
  'invoices:read',
  'suppliers:read',
  'reports:read',
  'companies:read',
  'events:read',
  'operations:read',
  'documents:read',
  'compliance:read',
  'payroll:read',
  'pending_operations:read',
]

/**
 * Scopes advertised in the RFC 8414 authorization-server metadata document
 * (/.well-known/oauth-authorization-server). Restricted to the same set that
 * /authorize will grant by default: destructive scopes still work when
 * requested explicitly, they just aren't enumerated for unauthenticated
 * callers (defense-in-depth against scope-escalation reconnaissance).
 */
export const PUBLIC_OAUTH_METADATA_SCOPES: ApiKeyScope[] = [...DEFAULT_OAUTH_SCOPES]

/**
 * Scopes that allow staging a pending_operation. Used to detect a
 * segregation-of-duties conflict when paired with `pending_operations:approve`
 * on the same API key (ISO 27001:2022 A.5.3, SOC 2 CC6.1).
 *
 * Documented system control (BFNAR 2013:2 systemdokumentation): `agent:write`
 * is deliberately NOT a staging scope. The memory tools it gates
 * (gnubok_remember_fact/forget_fact) write advisory agent context: they
 * cannot create, mutate, or stage räkenskapsinformation, so memory-write +
 * approve on one key does not let an agent both stage and commit bookkeeping.
 * If a future memory surface ever feeds DIRECTLY into voucher generation
 * (rather than via a separately staged-and-approved operation), revisit this
 * classification.
 */
export const STAGING_SCOPES: ApiKeyScope[] = [
  'transactions:write',
  'customers:write',
  'articles:write',
  'invoices:write',
  'suppliers:write',
  'bookkeeping:write',
  'payroll:write',
  'documents:write',
  'companies:write',
  // Skatteverket submit tools stage submit_vat_declaration / submit_agi, so a
  // key holding both this and pending_operations:approve is a SoD conflict:
  // findStageApproveConflict picks it up automatically from this list.
  'skatteverket:write',
  // gnubok_reconcile_match / gnubok_reconcile_unmatch stage reconciliation_*
  // operations; same SoD reasoning.
  'reconciliation:write',
  // gnubok_reconcile_signoff stages reconciliation_signoff.
  'reconciliation:signoff',
]

/**
 * Detect a segregation-of-duties conflict between staging and approval scopes
 * on the same key. Returns the offending staging scope, or null when the
 * combination is clean. Callers may choose to block, warn, or record an
 * acknowledged risk acceptance.
 *
 * Granting both stage+approve to the same actor lets an automated agent both
 * stage AND commit financial postings without a human-in-the-loop review,
 * which is the explicit control surface for BFNAR 2013:2 (behandlingshistorik)
 * and BFL 5 kap 5§ traceability requirements.
 */
export function findStageApproveConflict(scopes: ApiKeyScope[]): ApiKeyScope | null {
  if (!scopes.includes('pending_operations:approve')) return null
  return scopes.find((s) => STAGING_SCOPES.includes(s)) ?? null
}

/**
 * One entry per scope group, shared by every surface that lets a human pick
 * scopes (settings panel, OAuth consent page). Every scope in API_KEY_SCOPES
 * belongs to exactly one group: lib/auth/__tests__/scope-catalog.test.ts
 * enforces it, so a scope added to the catalogue without a group fails CI
 * instead of silently vanishing from the pickers.
 */
export type ScopeGroup = {
  /** Stable id: React key and i18n suffix (`group_<domain>`) in the panel. */
  domain: string
  /** Swedish label for surfaces without next-intl (the OAuth consent page). */
  label: string
  /** Display order: the `:read` scope first, then the elevated ones. */
  scopes: readonly ApiKeyScope[]
}

export const SCOPE_GROUPS: readonly ScopeGroup[] = [
  { domain: 'companies',          label: 'Företag',             scopes: ['companies:read', 'companies:write'] },
  { domain: 'transactions',       label: 'Transaktioner',       scopes: ['transactions:read', 'transactions:write'] },
  { domain: 'reconciliation',     label: 'Avstämning',          scopes: ['reconciliation:read', 'reconciliation:write', 'reconciliation:signoff'] },
  { domain: 'customers',          label: 'Kunder',              scopes: ['customers:read', 'customers:write'] },
  { domain: 'articles',           label: 'Artiklar',            scopes: ['articles:read', 'articles:write'] },
  { domain: 'invoices',           label: 'Fakturor',            scopes: ['invoices:read', 'invoices:write'] },
  { domain: 'suppliers',          label: 'Leverantörer',        scopes: ['suppliers:read', 'suppliers:write'] },
  { domain: 'reports',            label: 'Rapporter',           scopes: ['reports:read'] },
  { domain: 'bookkeeping',        label: 'Bokföring',           scopes: ['bookkeeping:write'] },
  { domain: 'payroll',            label: 'Löner',               scopes: ['payroll:read', 'payroll:write'] },
  { domain: 'documents',          label: 'Dokument',            scopes: ['documents:read', 'documents:write'] },
  { domain: 'pending_operations', label: 'Stagade operationer', scopes: ['pending_operations:read', 'pending_operations:approve'] },
  { domain: 'agent',              label: 'Agent',               scopes: ['agent:read', 'agent:write'] },
  { domain: 'skatteverket',       label: 'Skatteverket',        scopes: ['skatteverket:write'] },
  { domain: 'compliance',         label: 'Compliance',          scopes: ['compliance:read'] },
  { domain: 'events',             label: 'Händelser',           scopes: ['events:read'] },
  { domain: 'webhooks',           label: 'Webhooks',            scopes: ['webhooks:manage'] },
  { domain: 'operations',         label: 'Operationer',         scopes: ['operations:read'] },
]

/**
 * Read scopes are the implicit baseline; everything else (write, manage,
 * approve, signoff) is an elevated grant and is rendered as such.
 */
export function scopeKind(scope: ApiKeyScope): 'read' | 'write' {
  return scope.endsWith(':read') ? 'read' : 'write'
}

/** Map MCP tool name → required scope. Tools omitted from this map are available to any authenticated key (e.g. discovery/search/skill loading). */
export const TOOL_SCOPE_MAP: Record<string, ApiKeyScope> = {
  // Companies
  gnubok_list_companies:                  'companies:read',
  gnubok_create_company:                  'companies:write',
  gnubok_lookup_company:                  'companies:read',
  gnubok_connect_bank:                    'companies:read',
  gnubok_connect_skatteverket:            'companies:read',
  gnubok_connect_migration:               'companies:read',
  gnubok_get_company_settings:            'companies:read',
  gnubok_update_company_settings:         'companies:write',
  // Transactions
  gnubok_list_uncategorized_transactions:     'transactions:read',
  gnubok_list_cash_accounts:                  'transactions:read',
  gnubok_list_transactions_without_documents: 'transactions:read',
  gnubok_create_transactions:                 'transactions:write',
  gnubok_categorize_transaction:              'transactions:write',
  gnubok_receipt_matcher:                     'transactions:write',
  gnubok_get_counterparty_templates:          'transactions:read',
  gnubok_suggest_categories:                  'transactions:read',
  gnubok_match_transaction_to_invoice:        'transactions:write',
  gnubok_link_transaction_to_journal_entry:   'transactions:write',
  gnubok_match_batch_allocate:                'transactions:write',
  // Reconciliation (account-keyed). gnubok_get_reconciliation_status keeps its
  // historical reports:read so existing keys are not cut off.
  gnubok_list_reconciliation_items:           'reconciliation:read',
  gnubok_reconcile_match:                     'reconciliation:write',
  gnubok_reconcile_unmatch:                   'reconciliation:write',
  gnubok_reconcile_signoff:                   'reconciliation:signoff',
  // Residual booking writes a verifikat: the same scope that books a bank row.
  gnubok_reconcile_residual:                  'transactions:write',
  gnubok_bulk_book_transactions:              'transactions:write',
  gnubok_bulk_book_inbox_items:               'transactions:write',
  gnubok_auto_match_period:                   'transactions:write',
  // Skattekonto row booking writes a verifikat from an outside (SKV) row:
  // same scope family as reconcile_residual / bulk_book above.
  gnubok_book_skattekonto_row:                'transactions:write',
  gnubok_book_skattekonto_rows:               'transactions:write',
  // Customers
  gnubok_list_customers:                  'customers:read',
  gnubok_create_customer:                 'customers:write',
  gnubok_update_customer:                 'customers:write',
  // Articles (artikelregister)
  gnubok_list_articles:                   'articles:read',
  gnubok_create_article:                  'articles:write',
  gnubok_update_article:                  'articles:write',
  // Invoices
  gnubok_list_invoices:                   'invoices:read',
  gnubok_get_invoice:                     'invoices:read',
  gnubok_get_invoice_deliveries:          'invoices:read',
  gnubok_create_invoice:                  'invoices:write',
  gnubok_update_invoice:                  'invoices:write',
  gnubok_send_invoice:                    'invoices:write',
  gnubok_mark_invoice_as_paid:            'invoices:write',
  gnubok_mark_invoice_as_sent:            'invoices:write',
  // Recurring invoice schedules (staged template writes; no send/book at commit)
  gnubok_list_recurring_schedules:        'invoices:read',
  gnubok_create_recurring_schedule:       'invoices:write',
  gnubok_update_recurring_schedule:       'invoices:write',
  // Suppliers
  gnubok_list_suppliers:                  'suppliers:read',
  gnubok_list_supplier_invoices:          'suppliers:read',
  // Reports
  gnubok_get_trial_balance:               'reports:read',
  gnubok_get_vat_report:                  'reports:read',
  gnubok_vat_review_widget:               'reports:read',
  gnubok_vat_close_check:                 'reports:read',
  gnubok_get_kpi_report:                  'reports:read',
  gnubok_get_income_statement:            'reports:read',
  gnubok_list_accounts:                   'reports:read',
  // Kontoplan management: staged reference-data writes
  gnubok_create_account:                  'bookkeeping:write',
  gnubok_update_account:                  'bookkeeping:write',
  // Verifikat annotation (notes-only edit: allowed on posted entries)
  gnubok_set_voucher_note:                'bookkeeping:write',
  gnubok_get_balance_sheet:               'reports:read',
  gnubok_get_general_ledger:              'reports:read',
  gnubok_query_journal:                   'reports:read',
  gnubok_get_ar_ledger:                   'reports:read',
  gnubok_get_supplier_ledger:             'reports:read',
  gnubok_list_fiscal_periods:             'reports:read',
  gnubok_get_reconciliation_status:       'reports:read',
  gnubok_list_accrual_schedules:          'reports:read',
  // Dimensions (kostnadsställe/projekt) registry: reads next to the report
  // tools; the staged value-create is a bookkeeping write (dimensions PR3).
  gnubok_list_dimensions:                 'reports:read',
  gnubok_list_dimension_values:           'reports:read',
  gnubok_create_dimension_value:          'bookkeeping:write',
  gnubok_get_dimension_pnl:               'reports:read',
  // Staged bulk retag of posted-line dimensions (dimensions PR6).
  gnubok_tag_journal_lines:               'bookkeeping:write',
  // Document inbox
  gnubok_create_document_upload:          'transactions:write',
  gnubok_complete_document_upload:        'transactions:write',
  gnubok_upload_document:                 'transactions:write',
  gnubok_list_inbox_items:                'transactions:read',
  gnubok_get_inbox_item:                  'transactions:read',
  gnubok_list_unmatched_documents:        'transactions:read',
  gnubok_get_document_content:            'transactions:read',
  gnubok_attach_document_to_transaction:  'transactions:write',
  gnubok_link_document_to_voucher:        'bookkeeping:write',
  gnubok_link_documents_to_vouchers:      'bookkeeping:write',
  // Körjournal (mileage): trip log reads/writes are payroll surface
  // (milersättning, 7331); booking the verifikat is a journal write.
  gnubok_list_mileage_trips:              'payroll:read',
  gnubok_log_mileage_trip:                'payroll:write',
  gnubok_book_mileage_period:             'bookkeeping:write',
  // Payroll
  gnubok_list_employees:                  'payroll:read',
  gnubok_get_salary_run:                  'payroll:read',
  gnubok_get_salary_journal:              'payroll:read',
  gnubok_create_salary_run:               'payroll:write',
  gnubok_calculate_salary_run:            'payroll:write',
  gnubok_book_salary_run:                 'payroll:write',
  gnubok_generate_agi:                    'payroll:write',
  // Payroll gap-closure: reads + staged writes (1.6-1.8, 2.4)
  gnubok_get_employee:                    'payroll:read',
  gnubok_get_payslip:                     'payroll:read',
  gnubok_list_absence:                    'payroll:read',
  gnubok_update_payslip_line:             'payroll:write',
  gnubok_set_run_salary:                  'payroll:write',
  gnubok_register_absence:                'payroll:write',
  gnubok_delete_absence:                  'payroll:write',
  gnubok_create_employee:                 'payroll:write',
  gnubok_update_employee:                 'payroll:write',
  gnubok_set_employee_opening_balances:   'payroll:write',
  gnubok_get_vacation_balance:            'payroll:read',
  gnubok_close_vacation_year:             'payroll:write',
  // Bookkeeping write (Stream 1 Phase 1): high-risk, always staged
  gnubok_close_period:                    'bookkeeping:write',
  gnubok_lock_period:                     'bookkeeping:write',
  gnubok_unlock_period:                   'bookkeeping:write',
  gnubok_run_year_end:                    'bookkeeping:write',
  gnubok_post_kontantmetod_cutoff:        'bookkeeping:write',
  gnubok_year_end_readiness:              'reports:read',
  gnubok_set_opening_balances:            'bookkeeping:write',
  gnubok_run_currency_revaluation:        'bookkeeping:write',
  gnubok_explain_voucher_gap:             'bookkeeping:write',
  gnubok_list_voucher_gaps:               'reports:read',
  // Transaction reversal (medium-risk)
  gnubok_uncategorize_transaction:        'transactions:write',
  // SIE export (read-only) + import (write)
  gnubok_export_sie:                      'reports:read',
  gnubok_audit_package:                   'reports:read',
  gnubok_import_sie:                      'bookkeeping:write',
  // Byte-exact SIE upload URL feeding gnubok_import_sie (same write intent).
  gnubok_create_sie_upload:               'bookkeeping:write',
  // Rot/rut begäran om utbetalning (records a payout request on generate)
  gnubok_generate_rot_rut_file:           'invoices:write',
  // Supplier CRUD
  gnubok_create_supplier:                 'suppliers:write',
  // Supplier invoice lifecycle
  gnubok_approve_supplier_invoice:        'suppliers:write',
  gnubok_credit_supplier_invoice:         'suppliers:write',
  gnubok_create_supplier_invoice_from_inbox: 'suppliers:write',
  gnubok_set_inbox_extracted_data:        'suppliers:write',
  // Supplier invoice payment via existing verifikat (no new bokföring)
  gnubok_find_voucher_candidates_for_supplier_invoice: 'suppliers:read',
  gnubok_link_supplier_invoice_to_voucher: 'suppliers:write',
  // Invoice conversion + crediting
  gnubok_convert_invoice:                 'invoices:write',
  gnubok_credit_invoice:                  'invoices:write',
  // Phase 4: arbitrary-line bookkeeping primitives (high-risk, always staged)
  gnubok_create_voucher:                  'bookkeeping:write',
  gnubok_correct_entry:                   'bookkeeping:write',
  gnubok_reverse_journal_entry:           'bookkeeping:write',
  // Agent surface (Phase 6 MCP parity): briefing tool exposes company-specific
  // profile + memory so it's scoped; gnubok_list_skills / gnubok_load_skill
  // stay unscoped (discovery + static Markdown bodies + globally-readable atom
  // registry: no per-company data).
  gnubok_get_agent_briefing:              'agent:read',
  // Agent memory write (previously UNMAPPED → callable by any key). Mapping to
  // agent:write; existing non-revoked keys are grandfathered in the
  // 20260619140000 migration so this does not regress them.
  gnubok_remember_fact:                   'agent:write',
  gnubok_forget_fact:                     'agent:write',
  // Pending operations approval (mirrors the /pending web UI)
  gnubok_list_pending_operations:         'pending_operations:read',
  gnubok_approve_pending_operation:       'pending_operations:approve',
  gnubok_reject_pending_operation:        'pending_operations:approve',
  // Skatteverket filing (PR5). Reads are compliance:read (status of moms/AGI);
  // the two submit tools require the opt-in skatteverket:write staging scope.
  gnubok_vat_declaration_validate:        'compliance:read',
  gnubok_vat_declaration_status:          'compliance:read',
  gnubok_agi_status:                      'compliance:read',
  gnubok_vat_declaration_submit:          'skatteverket:write',
  gnubok_agi_submit:                      'skatteverket:write',

  // ── Audit retrofit (agent-native audit P0: unmapped = default-allow) ──
  // These tools shipped without a scope mapping, making them callable by ANY
  // authenticated key. Mapping them is accept-the-break by decision
  // (2026-07-13): keys that relied on the default-allow hole lose access
  // until granted the proper scope. Release-note callout required for the
  // four WRITES below.
  gnubok_link_invoice_to_voucher:              'invoices:write',
  gnubok_undo_sie_import:                      'bookkeeping:write',
  gnubok_post_annual_depreciation:             'bookkeeping:write',
  gnubok_import_rot_rut_beslut:                'invoices:write',
  gnubok_list_verifikat_without_documents:     'transactions:read',
  gnubok_find_voucher_candidates_for_invoice:  'invoices:read',
  gnubok_propose_dispositioner:                'reports:read',
  gnubok_propose_accruals:                     'reports:read',
  gnubok_propose_annual_depreciation:          'reports:read',
  gnubok_preview_arsredovisning:               'reports:read',
  gnubok_validate_arsredovisning:              'reports:read',
  gnubok_list_arsredovisning_versions:         'reports:read',
  gnubok_get_arsredovisning_filing_status:     'reports:read',
  gnubok_preview_ef_declaration:               'reports:read',
  // Deliberately UNSCOPED (available to any authenticated key):
  // gnubok_search_tools, gnubok_list_skills, gnubok_load_skill,
  // gnubok_feedback. Discovery + static skill bodies + feedback channel
  // carry no per-company data; keeping them open is what lets an agent
  // orient itself before its key's scopes are known.
}

/**
 * Number of MCP tools gated by each scope, derived from TOOL_SCOPE_MAP at
 * module load. 0 means the scope only gates REST endpoints. Never hand-write
 * these numbers into labels: they drift the moment a tool is added.
 */
export const TOOL_COUNT_BY_SCOPE: Readonly<Record<ApiKeyScope, number>> = (() => {
  const counts = Object.fromEntries(ALL_SCOPES.map((s) => [s, 0])) as Record<ApiKeyScope, number>
  for (const scope of Object.values(TOOL_SCOPE_MAP)) counts[scope] += 1
  return counts
})()
