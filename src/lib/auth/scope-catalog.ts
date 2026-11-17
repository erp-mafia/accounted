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
  'transactions:write': { label: 'Transaktioner: skriv', description: 'Kategorisera, av-kategorisera, ignorera, kvittomatchning, koppling mot faktura' },
  'customers:read':     { label: 'Kunder: läs',         description: 'Lista kunder' },
  'customers:write':    { label: 'Kunder: skriv',       description: 'Skapa och uppdatera kunder' },
  'articles:read':      { label: 'Artiklar: läs',       description: 'Lista artiklar i artikelregistret' },
  'articles:write':     { label: 'Artiklar: skriv',     description: 'Skapa och uppdatera artiklar' },
  'invoices:read':      { label: 'Fakturor: läs',       description: 'Lista fakturor och kundorder' },
  // Narrow write scopes (crm#1548): an integration that may only prepare
  // what a person then sends, books or pays. Each is included in its write
  // scope (SCOPE_INCLUDED_IN), so a key holding the write scope keeps every
  // door it had; a key holding only the narrow one opens nothing else.
  'invoices:draft':     { label: 'Fakturor: utkast',    description: 'Skapa och ändra fakturautkast och offerter; aldrig skicka, bokföra, kreditera eller markera betald' },
  'invoices:write':     { label: 'Fakturor: skriv',     description: 'Skapa, skicka, markera betald/skickad; kundorder (skapa, bekräfta, leverera, fakturera)' },
  'suppliers:read':     { label: 'Leverantörer: läs',   description: 'Lista leverantörer och leverantörsfakturor, hitta verifikat-kandidater' },
  'suppliers:register': { label: 'Leverantörer: registrera', description: 'Registrera och ändra leverantörsfakturor som inte bokförs vid registreringen; aldrig godkänna, bokföra, kreditera eller betala' },
  'suppliers:write':    { label: 'Leverantörer: skriv', description: 'Skapa leverantörer; godkänn, kreditera, betal-länka och hantera leverantörsfakturor' },
  'reports:read':       { label: 'Rapporter: läs',      description: 'Kontoplan, huvudbok, balansräkning, resultaträkning, moms, KPI, reskontra, perioder, bankavstämning, SIE-export' },
  // The dimension registry alone, to tag invoice lines without reading the
  // books (crm#1548). Included in reports:read and invoices:read.
  'dimensions:read':    { label: 'Dimensioner: läs',    description: 'Lista dimensioner och deras värden (kostnadsställe, projekt, egna) för att märka rader' },
  'bookkeeping:write':  { label: 'Bokföring: skriv',    description: 'Stänga/låsa perioder, ingående balans, bokslut, SIE-import, voucher-gap-förklaringar, kontoplan (skapa/ändra konton), verifikat-anteckningar' },
  'payroll:read':       { label: 'Löner: läs',          description: 'Lista anställda, lönekörningar, lönejournal, körjournal' },
  'payroll:write':      { label: 'Löner: skriv',        description: 'Skapa lönekörning, beräkna, generera AGI, logga körjournalresor' },
  // v1 REST API: added Phase 1
  'companies:read':     { label: 'Företag: läs',        description: 'Lista och visa företagsprofiler som API-nyckeln har tillgång till' },
  'companies:write':    { label: 'Företag: skriv',      description: 'Skapa nya företag och uppdatera företagsinställningar (gnubok_create_company, stagade verktyg, REST POST /api/v1/companies och PATCH /api/v1/companies/{companyId}/settings)' },
  'events:read':        { label: 'Händelser: läs',      description: 'Polla händelseloggen (event_log) som webhook-fallback' },
  'webhooks:manage':    { label: 'Webhooks: hantera',   description: 'Skapa, lista, uppdatera och radera webhook-prenumerationer' },
  // Service accounts (lib/service-accounts): a non-human principal with a
  // human sponsor, and the keys it acts with. Opt-in on purpose: no key held
  // it before it existed, so no existing grant silently gained the power to
  // mint credentials. A service account's own key never uses it.
  'service_accounts:manage': { label: 'Tjänstekonton: hantera', description: 'Skapa, lista och återkalla tjänstekonton och deras nycklar (REST /api/v1/companies/{companyId}/service-accounts; MCP listar och stagar återkallelse, skapar aldrig nycklar); endast ägare och administratörer' },
  'operations:read':    { label: 'Operationer: läs',    description: 'Hämta status för långkörande operationer (importer, bokslut, omvärdering)' },
  'documents:read':     { label: 'Dokument: läs',       description: 'Lista och hämta dokumentbilagor' },
  'documents:write':    { label: 'Dokument: skriv',     description: 'Ladda upp och koppla dokument till verifikationer' },
  'compliance:read':    { label: 'Compliance: läs',     description: 'Pre-flight-kontroller: momsstängning, bokslutsberedskap, voucher-gap, IB/UB-kontinuitet; Skatteverket-status (moms + AGI)' },
  'skatteverket:write': { label: 'Skatteverket: skriv', description: 'Lämna momsdeklaration och arbetsgivardeklaration (AGI) till Skatteverket (stagas; signeras med BankID)' },
  'agent:read':         { label: 'Agent: läs',          description: 'Specialiserad bokföringsassistent: profil, laddade specialister/atomer, minnen (briefing + skill-katalog)' },
  'agent:write':        { label: 'Agent: skriv',        description: 'Spara och ta bort agentens minnen om företaget (remember_fact, forget_fact) och spara, ändra och ta bort egna skills (create_skill)' },
  // Shown to users as "Agentförslag", the name of the review list under
  // Att göra (issue #3408): "stagade operationer" read as developer jargon.
  'pending_operations:read':    { label: 'Agentförslag: läs',     description: 'Lista agentförslag som väntar på ditt godkännande' },
  'pending_operations:approve': { label: 'Agentförslag: godkänn', description: 'Godkänn eller avvisa agentförslag via API/MCP: då bokförs de utan din granskning i appen' },
  // Reconciliation (account-keyed: bank accounts + skattekonto). Reads cover
  // the account list, the bridge and the item buckets; writes cover links
  // (match/unmatch) and ignore flags. Links never touch the ledger.
  'reconciliation:read':  { label: 'Avstämning: läs',   description: 'Konton att stämma av, bryggan per konto och raderna bakom den (bank + skattekonto)' },
  'reconciliation:write': { label: 'Avstämning: skriv', description: 'Koppla och koppla bort händelser mot verifikat, ignorera rader (MCP stagar; REST skriver direkt)' },
  'reconciliation:signoff': { label: 'Avstämning: signera', description: 'Markera ett konto som avstämt t.o.m. ett datum och öppna en signering igen (MCP stagar; REST skriver direkt)' },
  // Rows of the liquidity forecast (lib/forecast): expected money in or out
  // that the books do not hold yet. Not bookkeeping, so REST and MCP both
  // write directly (decision 2026-10-28) and it is not a STAGING_SCOPE. The
  // forecast and the rows are read with reports:read.
  'forecast:write':     { label: 'Likviditetsprognos: skriv', description: 'Lägg till, uppdatera och stryk rader i likviditetsprognosen (skrivs direkt, når aldrig bokföringen)' },
} as const

export type ApiKeyScope = keyof typeof API_KEY_SCOPES

export const ALL_SCOPES: ApiKeyScope[] = Object.keys(API_KEY_SCOPES) as ApiKeyScope[]

/**
 * Narrow scopes and the broader grants that include them. A door that needs
 * `invoices:draft` opens for a key holding `invoices:write` too, so moving a
 * door onto a narrow scope never takes it from an existing key. Inclusion
 * runs one way only: a narrow scope never satisfies a broader door.
 * hasScope (lib/auth/api-keys.ts) reads this; nothing else may widen a scope.
 */
export const SCOPE_INCLUDED_IN: Readonly<Partial<Record<ApiKeyScope, readonly ApiKeyScope[]>>> = {
  'invoices:draft': ['invoices:write'],
  'suppliers:register': ['suppliers:write'],
  'dimensions:read': ['reports:read', 'invoices:read'],
}

/** Does a key holding `keyScopes` satisfy a door that requires `required`? */
export function scopeSatisfied(keyScopes: readonly string[], required: ApiKeyScope): boolean {
  if (keyScopes.includes(required)) return true
  return SCOPE_INCLUDED_IN[required]?.some((broader) => keyScopes.includes(broader)) ?? false
}

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
  'invoices:draft',
  'invoices:write',
  'suppliers:register',
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
 * Scopes whose MCP writes commit on the call instead of staging for a
 * person's approval (OperationMcpBinding.direct). Only data that never
 * reaches the books belongs here: forecast:write writes the liquidity
 * forecast's rows, planning data that no verifikat reads (decision
 * 2026-10-28). Every scope that creates or changes räkenskapsinformation
 * stages (STAGING_SCOPES).
 */
export const DIRECT_WRITE_SCOPES: readonly ApiKeyScope[] = ['forecast:write']

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
  { domain: 'invoices',           label: 'Fakturor',            scopes: ['invoices:read', 'invoices:draft', 'invoices:write'] },
  { domain: 'suppliers',          label: 'Leverantörer',        scopes: ['suppliers:read', 'suppliers:register', 'suppliers:write'] },
  { domain: 'dimensions',         label: 'Dimensioner',         scopes: ['dimensions:read'] },
  { domain: 'reports',            label: 'Rapporter',           scopes: ['reports:read'] },
  { domain: 'forecast',           label: 'Likviditetsprognos',  scopes: ['forecast:write'] },
  { domain: 'bookkeeping',        label: 'Bokföring',           scopes: ['bookkeeping:write'] },
  { domain: 'payroll',            label: 'Löner',               scopes: ['payroll:read', 'payroll:write'] },
  { domain: 'documents',          label: 'Dokument',            scopes: ['documents:read', 'documents:write'] },
  { domain: 'pending_operations', label: 'Agentförslag',        scopes: ['pending_operations:read', 'pending_operations:approve'] },
  { domain: 'agent',              label: 'Agent',               scopes: ['agent:read', 'agent:write'] },
  { domain: 'skatteverket',       label: 'Skatteverket',        scopes: ['skatteverket:write'] },
  { domain: 'compliance',         label: 'Compliance',          scopes: ['compliance:read'] },
  { domain: 'events',             label: 'Händelser',           scopes: ['events:read'] },
  { domain: 'webhooks',           label: 'Webhooks',            scopes: ['webhooks:manage'] },
  { domain: 'service_accounts',   label: 'Tjänstekonton',       scopes: ['service_accounts:manage'] },
  { domain: 'operations',         label: 'Operationer',         scopes: ['operations:read'] },
]

/**
 * Read scopes are the implicit baseline; everything else (write, manage,
 * approve, signoff) is an elevated grant and is rendered as such.
 */
export function scopeKind(scope: ApiKeyScope): 'read' | 'write' {
  return scope.endsWith(':read') ? 'read' : 'write'
}

/**
 * Map MCP tool name → required scope. Every registered tool is in exactly one
 * of this map and UNSCOPED_TOOLS; the dispatcher refuses a tool in neither, so
 * a new tool without a scope fails closed instead of opening to every key.
 */
export const TOOL_SCOPE_MAP: Record<string, ApiKeyScope> = {
  // Companies
  gnubok_list_companies:                  'companies:read',
  gnubok_create_company:                  'companies:write',
  gnubok_lookup_company:                  'companies:read',
  // Multi-company (one connection, every company): the scoped read tools
  // need companies:read for the scope itself; run_across_companies then
  // checks the inner tool's own scope per call, and stage_across_companies
  // requires the inner write tool's scope on top of this one.
  gnubok_client_overview:                 'companies:read',
  gnubok_portfolio_readiness:             'reports:read',
  gnubok_run_across_companies:            'companies:read',
  gnubok_stage_across_companies:          'companies:read',
  gnubok_connect_bank:                    'companies:read',
  gnubok_sync_bank:                       'transactions:write',
  gnubok_list_feed_connections:           'transactions:read',
  gnubok_backfill_feed:                   'transactions:write',
  gnubok_connect_skatteverket:            'companies:read',
  gnubok_connect_migration:               'companies:read',
  gnubok_get_company_settings:            'companies:read',
  gnubok_get_tax_account_ledger_setting:  'companies:read',
  gnubok_update_company_settings:         'companies:write',
  // Packages (Lön, Kundfakturor, ...): their status, and the staged switch an owner or admin approves.
  gnubok_list_packages:                   'companies:read',
  gnubok_enable_package:                  'companies:write',
  gnubok_disable_package:                 'companies:write',
  // Service accounts: the same opt-in scope as the v1 doors; a service
  // account's own key never holds it.
  gnubok_list_service_accounts:           'service_accounts:manage',
  gnubok_revoke_service_account:          'service_accounts:manage',
  // Transactions
  gnubok_list_uncategorized_transactions:     'transactions:read',
  gnubok_list_cash_accounts:                  'transactions:read',
  gnubok_list_transactions_without_documents: 'transactions:read',
  gnubok_get_transaction:                     'transactions:read',
  gnubok_create_transactions:                 'transactions:write',
  gnubok_categorize_transaction:              'transactions:write',
  gnubok_ignore_transaction:                  'transactions:write',
  gnubok_bulk_ignore_transactions:            'transactions:write',
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
  // Reached through a supplier, or a bare party_id, it also needs
  // suppliers:read: see argumentScopeFor below.
  gnubok_get_party:                       'customers:read',
  gnubok_get_customer:                    'customers:read',
  gnubok_create_customer:                 'customers:write',
  gnubok_update_customer:                 'customers:write',
  gnubok_merge_customers:                 'customers:write',
  // Articles (artikelregister)
  gnubok_list_articles:                   'articles:read',
  gnubok_create_article:                  'articles:write',
  gnubok_update_article:                  'articles:write',
  // Invoices
  gnubok_list_invoices:                   'invoices:read',
  gnubok_get_invoice:                     'invoices:read',
  gnubok_get_invoice_deliveries:          'invoices:read',
  gnubok_get_invoice_pdf:                 'invoices:read',
  gnubok_list_invoice_underlag:           'invoices:read',
  // Drafts only (the update refuses anything past draft): invoices:draft,
  // which invoices:write includes. Every door out of draft stays on write.
  gnubok_create_invoice:                  'invoices:draft',
  gnubok_update_invoice:                  'invoices:draft',
  gnubok_delete_draft_invoice:            'invoices:write',
  gnubok_send_invoice:                    'invoices:write',
  gnubok_attach_invoice_underlag:         'invoices:write',
  gnubok_detach_invoice_underlag:         'invoices:write',
  gnubok_mark_invoice_as_paid:            'invoices:write',
  gnubok_mark_invoice_as_sent:            'invoices:write',
  // An invoice already booked elsewhere (SIE) into the kundreskontra: stages, books nothing
  gnubok_register_booked_invoice:         'invoices:write',
  // Kundorder (sales orders): the pre-invoice document. Reads and staged
  // writes ride the invoice scopes (an order exists only to become one).
  gnubok_list_sales_orders:               'invoices:read',
  gnubok_get_sales_order:                 'invoices:read',
  gnubok_create_sales_order:              'invoices:write',
  gnubok_transition_sales_order:          'invoices:write',
  gnubok_register_sales_order_delivery:   'invoices:write',
  gnubok_create_invoice_from_sales_order: 'invoices:write',
  // Recurring invoice schedules (staged template writes; no send/book at commit)
  gnubok_list_recurring_schedules:        'invoices:read',
  gnubok_create_recurring_schedule:       'invoices:write',
  gnubok_update_recurring_schedule:       'invoices:write',
  // Suppliers
  gnubok_list_suppliers:                  'suppliers:read',
  gnubok_get_supplier:                    'suppliers:read',
  gnubok_list_supplier_invoices:          'suppliers:read',
  gnubok_get_supplier_invoice:            'suppliers:read',
  // Reports
  gnubok_get_trial_balance:               'reports:read',
  gnubok_get_vat_report:                  'reports:read',
  gnubok_vat_review_widget:               'reports:read',
  gnubok_vat_close_check:                 'reports:read',
  gnubok_list_vat_filings:                'reports:read',
  gnubok_get_kpi_report:                  'reports:read',
  gnubok_get_income_statement:            'reports:read',
  gnubok_list_accounts:                   'reports:read',
  // Kontoplan management: staged reference-data writes
  gnubok_create_account:                  'bookkeeping:write',
  gnubok_update_account:                  'bookkeeping:write',
  // Verifikat annotation (notes-only edit: allowed on posted entries)
  gnubok_set_voucher_note:                'bookkeeping:write',
  // Cancel an uncommitted draft (no voucher number, row kept as cancelled)
  gnubok_cancel_draft_entry:              'bookkeeping:write',
  gnubok_get_balance_sheet:               'reports:read',
  gnubok_get_general_ledger:              'reports:read',
  gnubok_query_journal:                   'reports:read',
  gnubok_get_ar_ledger:                   'reports:read',
  gnubok_get_supplier_ledger:             'reports:read',
  // Liquidity forecast (lib/operations/cash-forecast.ts): read with the
  // reports, its rows written directly under forecast:write (not bookkeeping).
  gnubok_get_cash_forecast:               'reports:read',
  gnubok_list_cash_forecast_rows:         'reports:read',
  gnubok_upsert_cash_forecast_rows:       'forecast:write',
  gnubok_cancel_cash_forecast_row:        'forecast:write',
  gnubok_list_fiscal_periods:             'reports:read',
  gnubok_get_reconciliation_status:       'reports:read',
  gnubok_list_accrual_schedules:          'reports:read',
  gnubok_list_deadlines:                  'reports:read',
  // Dimensions (kostnadsställe/projekt) registry: dimensions:read, which
  // reports:read and invoices:read include; the staged value-create is a
  // bookkeeping write (dimensions PR3).
  gnubok_list_dimensions:                 'dimensions:read',
  gnubok_list_dimension_values:           'dimensions:read',
  gnubok_create_dimension_value:          'bookkeeping:write',
  // Operation registry, wave 4: Peppol, årsredovisning, IB, AP actions.
  gnubok_get_invoice_peppol_readiness: 'invoices:read',
  gnubok_send_invoice_peppol: 'invoices:write',
  gnubok_list_invoice_peppol_deliveries: 'invoices:read',
  gnubok_get_peppol_registration: 'companies:read',
  gnubok_register_peppol_participant: 'companies:write',
  gnubok_request_peppol_access: 'companies:write',
  gnubok_update_arsredovisning_narrative: 'bookkeeping:write',
  gnubok_update_arsredovisning_compliance: 'bookkeeping:write',
  gnubok_create_arsredovisning_version: 'bookkeeping:write',
  gnubok_add_arsredovisning_signature: 'bookkeeping:write',
  gnubok_list_arsredovisning_signatories: 'reports:read',
  gnubok_validate_arsredovisning_ixbrl: 'reports:read',
  gnubok_set_opening_balances_manual: 'bookkeeping:write',
  gnubok_correct_opening_balances: 'bookkeeping:write',
  gnubok_preview_opening_balance_split: 'reports:read',
  gnubok_split_opening_balances_per_project: 'bookkeeping:write',
  gnubok_list_pos_connections: 'transactions:read',
  gnubok_list_pos_venues: 'transactions:read',
  gnubok_connect_pos_venue: 'companies:write',
  gnubok_disconnect_pos_connection: 'companies:write',
  gnubok_update_pos_settings: 'companies:write',
  gnubok_list_pos_sales_days: 'transactions:read',
  gnubok_get_pos_sales_day: 'transactions:read',
  gnubok_book_pos_sales_day: 'bookkeeping:write',
  gnubok_get_pos_clearing_balance: 'transactions:read',
  gnubok_list_webshop_orders: 'transactions:read',
  gnubok_get_webshop_order: 'transactions:read',
  gnubok_book_webshop_order: 'bookkeeping:write',
  gnubok_book_webshop_day: 'bookkeeping:write',
  gnubok_get_oss_underlag: 'reports:read',
  // Dröjsmålsränta per customer invoice (lib/operations/late-payment-interest.ts).
  gnubok_get_late_payment_interest: 'invoices:read',
  // Collections (served while COLLECTIONS_ENABLED is set).
  gnubok_list_collection_candidates: 'invoices:read',
  gnubok_get_collection_case: 'invoices:read',
  gnubok_send_invoice_to_collection: 'invoices:write',
  gnubok_collection_case_action: 'invoices:write',
  gnubok_list_collection_settlements: 'invoices:read',
  gnubok_book_collected_payment: 'invoices:write',
  gnubok_book_collection_settlement: 'bookkeeping:write',
  // Kundförlust (served while CUSTOMER_LOSS_ENABLED is set).
  gnubok_record_customer_loss: 'invoices:write',
  gnubok_list_inventory_counts: 'reports:read',
  gnubok_get_inventory_count: 'reports:read',
  gnubok_save_inventory_count: 'bookkeeping:write',
  gnubok_book_inventory_count: 'bookkeeping:write',
  // Kvittning (served while COUNTERPARTY_SETOFF_ENABLED is set).
  gnubok_get_counterparty_balance: 'reports:read',
  gnubok_book_counterparty_setoff: 'invoices:write',
  gnubok_delete_supplier_invoice: 'suppliers:write',
  gnubok_uncredit_supplier_invoice: 'suppliers:write',
  gnubok_update_supplier_invoice: 'suppliers:write',
  gnubok_update_supplier_invoice_item_account: 'suppliers:write',
  gnubok_agi_validate_huvuduppgift: 'compliance:read',
  // Operation registry, wave 3: documents, transactions, rättelse, filing.
  gnubok_delete_document: 'documents:write',
  gnubok_detach_document_from_transaction: 'transactions:write',
  gnubok_delete_inbox_item: 'documents:write',
  gnubok_unmatch_inbox_item_transaction: 'documents:write',
  gnubok_set_inbox_purchase_category: 'documents:write',
  gnubok_undo_bank_import: 'transactions:write',
  gnubok_correct_entry_metadata: 'bookkeeping:write',
  gnubok_correct_entry_lines: 'bookkeeping:write',
  gnubok_replan_accrual_schedule: 'bookkeeping:write',
  gnubok_create_accrual_schedule: 'bookkeeping:write',
  gnubok_cancel_accrual_schedule: 'bookkeeping:write',
  // K3 (lib/operations/k3.ts)
  gnubok_post_asset_value_adjustment: 'bookkeeping:write',
  gnubok_replace_asset_component: 'bookkeeping:write',
  gnubok_set_asset_tax_plan: 'bookkeeping:write',
  gnubok_split_asset_at_k3_transition: 'bookkeeping:write',
  gnubok_set_deferred_tax_inputs: 'bookkeeping:write',
  gnubok_set_development_model: 'companies:write',
  gnubok_get_k3_transition: 'reports:read',
  gnubok_start_k3_transition: 'bookkeeping:write',
  gnubok_update_k3_transition: 'bookkeeping:write',
  gnubok_delete_k3_transition: 'bookkeeping:write',
  gnubok_commit_k3_transition: 'bookkeeping:write',
  gnubok_redate_entry: 'bookkeeping:write',
  gnubok_mark_no_document_required: 'bookkeeping:write',
  gnubok_get_rattelse_log: 'reports:read',
  gnubok_get_ink2_declaration: 'reports:read',
  gnubok_get_ink3_underlag: 'reports:read',
  gnubok_get_ne_bilaga: 'reports:read',
  gnubok_get_periodisk_sammanstallning: 'reports:read',
  gnubok_get_cash_flow_statement: 'reports:read',
  gnubok_get_behandlingshistorik: 'reports:read',
  gnubok_get_bokslutsbilagor: 'reports:read',
  gnubok_get_forenklat_arsbokslut: 'reports:read',
  gnubok_list_measures: 'reports:read',
  gnubok_get_measure: 'reports:read',
  gnubok_explain_measure: 'reports:read',
  gnubok_list_unexplained: 'reports:read',
  gnubok_get_unexplained: 'reports:read',
  gnubok_explain_unexplained: 'reports:read',
  gnubok_get_vat_settlement_proposal: 'reports:read',
  gnubok_book_vat_settlement: 'bookkeeping:write',
  gnubok_mark_vat_period_filed: 'bookkeeping:write',
  gnubok_unmark_vat_period_filed: 'bookkeeping:write',
  gnubok_mark_vat_check_reviewed: 'bookkeeping:write',
  gnubok_mark_not_momsredovisning: 'bookkeeping:write',
  gnubok_withdraw_not_momsredovisning: 'bookkeeping:write',
  gnubok_mark_agi_period_filed: 'payroll:write',
  gnubok_complete_deadline: 'bookkeeping:write',
  // Operation registry, wave 2: booking, payment files, utlägg, payroll.
  gnubok_send_payslips: 'payroll:write',
  gnubok_revert_salary_run: 'payroll:write',
  gnubok_unapprove_salary_run: 'payroll:write',
  gnubok_attach_salary_expense_claims: 'payroll:write',
  // Payroll over MCP, run structure (lib/operations/salary-run-structure.ts).
  gnubok_list_salary_runs: 'payroll:read',
  gnubok_add_salary_run_employee: 'payroll:write',
  gnubok_remove_salary_run_employee: 'payroll:write',
  gnubok_add_payslip_line: 'payroll:write',
  gnubok_delete_payslip_line: 'payroll:write',
  gnubok_correct_salary_run: 'payroll:write',
  gnubok_mark_salary_run_paid: 'payroll:write',
  gnubok_list_salary_payment_files: 'payroll:read',
  // Fora's monthly report, summary only (lib/operations/salary-fora-report.ts).
  gnubok_get_fora_report: 'payroll:read',
  // Payroll over MCP, employee setup (lib/operations/salary-employee-setup.ts).
  gnubok_list_worked_days: 'payroll:read',
  gnubok_set_worked_days: 'payroll:write',
  gnubok_delete_worked_days: 'payroll:write',
  gnubok_list_employee_benefits: 'payroll:read',
  gnubok_add_employee_benefit: 'payroll:write',
  gnubok_update_employee_benefit: 'payroll:write',
  gnubok_delete_employee_benefit: 'payroll:write',
  gnubok_list_employee_recurring_lines: 'payroll:read',
  gnubok_add_employee_recurring_line: 'payroll:write',
  gnubok_update_employee_recurring_line: 'payroll:write',
  gnubok_delete_employee_recurring_line: 'payroll:write',
  gnubok_delete_employee: 'payroll:write',
  gnubok_preview_supplier_payment_batch: 'suppliers:read',
  gnubok_list_supplier_payment_batches: 'suppliers:read',
  gnubok_get_supplier_payment_batch: 'suppliers:read',
  gnubok_create_supplier_payment_batch: 'suppliers:write',
  gnubok_cancel_supplier_payment_batch: 'suppliers:write',
  gnubok_list_payment_orders: 'suppliers:read',
  gnubok_get_payment_order: 'suppliers:read',
  gnubok_get_payments_availability: 'suppliers:read',
  gnubok_get_payments_usage: 'suppliers:read',
  gnubok_get_payments_verification: 'suppliers:read',
  gnubok_prepare_payments: 'suppliers:write',
  gnubok_cancel_payment_order: 'suppliers:write',
  gnubok_get_payments_signing_link: 'suppliers:read',
  gnubok_request_payment_signature: 'suppliers:write',
  // BankID document signing (lib/operations/signing-requests.ts).
  gnubok_request_signature: 'documents:write',
  gnubok_list_signing_requests: 'documents:read',
  gnubok_get_signing_request: 'documents:read',
  gnubok_remind_signer: 'documents:write',
  gnubok_request_arsredovisning_signatures: 'bookkeeping:write',
  // Bolaget registers: aktiebok, share classes, roles, firmateckning, verkliga huvudmän (lib/operations/bolaget.ts).
  gnubok_get_share_register: 'companies:read',
  gnubok_list_share_events: 'companies:read',
  gnubok_register_share_event: 'companies:write',
  gnubok_create_share_class: 'companies:write',
  gnubok_update_share_class: 'companies:write',
  gnubok_list_company_roles: 'companies:read',
  gnubok_add_company_role: 'companies:write',
  gnubok_end_company_role: 'companies:write',
  gnubok_set_signatory_rule: 'companies:write',
  gnubok_get_beneficial_owners: 'companies:read',
  gnubok_confirm_beneficial_owners: 'companies:write',
  // Bolaget capital events: dividends, KU31 status, tillskott, emissions (lib/operations/bolaget-capital.ts).
  gnubok_get_capital_events: 'companies:read',
  gnubok_get_ku31_status: 'companies:read',
  gnubok_create_dividend: 'companies:write',
  gnubok_book_dividend: 'bookkeeping:write',
  gnubok_pay_dividend: 'bookkeeping:write',
  gnubok_create_shareholder_contribution: 'bookkeeping:write',
  gnubok_create_capital_change: 'companies:write',
  gnubok_book_capital_change: 'bookkeeping:write',
  // Bolaget owner tax: K10 underlag, owner loans, KU20 status (lib/operations/bolaget-owner-tax.ts).
  gnubok_get_k10_underlag: 'payroll:read',
  gnubok_get_owner_loans: 'companies:read',
  gnubok_get_ku20_status: 'companies:read',
  gnubok_set_k10_owner_inputs: 'companies:write',
  gnubok_create_owner_loan: 'companies:write',
  gnubok_update_owner_loan: 'companies:write',
  gnubok_set_owner_loan_interest: 'companies:write',
  // Bolaget meetings and minutes (lib/operations/corporate-meetings.ts).
  gnubok_list_corporate_meetings: 'companies:read',
  gnubok_get_corporate_meeting: 'companies:read',
  gnubok_create_corporate_meeting: 'companies:write',
  gnubok_update_corporate_meeting: 'companies:write',
  gnubok_record_corporate_decision: 'companies:write',
  gnubok_hold_corporate_meeting: 'companies:write',
  // Commitments and holdings (lib/operations/commitments.ts, Bolaget rollout).
  gnubok_list_agreements: 'companies:read',
  gnubok_list_agreement_obligations: 'companies:read',
  gnubok_create_agreement: 'companies:write',
  gnubok_update_agreement: 'companies:write',
  gnubok_end_agreement: 'companies:write',
  gnubok_list_securities: 'companies:read',
  gnubok_create_security: 'companies:write',
  gnubok_update_security: 'companies:write',
  gnubok_list_group_links: 'companies:read',
  gnubok_create_group_link: 'companies:write',
  gnubok_update_group_link: 'companies:write',
  // The attest policy for supplier invoices (lib/operations/supplier-invoice-attest.ts).
  gnubok_get_attest_policy: 'suppliers:read',
  gnubok_get_supplier_invoice_attestations: 'suppliers:read',
  // Changed supplier bank details: stages a person's approval (web UI only).
  gnubok_confirm_supplier_payee: 'suppliers:write',
  // Bankgiro Lookup (lib/operations/bankgiro-lookup.ts): the registered name
  // behind a payee's giro, and the company's own registered giro numbers.
  gnubok_lookup_bankgiro_creditor: 'suppliers:read',
  gnubok_list_company_giro_numbers: 'companies:read',
  // Bank reading through Open Payments (lib/operations/bank-feed.ts): the
  // reads and the signatory link; the BankID act itself has no tool.
  gnubok_list_bank_feed_banks: 'transactions:read',
  gnubok_get_bank_feed_bank: 'transactions:read',
  gnubok_bank_feed_overview: 'transactions:read',
  gnubok_bank_feed_switch_progress: 'transactions:read',
  gnubok_bank_feed_connect_link: 'transactions:write',
  gnubok_book_invoice: 'invoices:write',
  gnubok_bulk_book_invoices: 'invoices:write',
  gnubok_book_supplier_invoice: 'suppliers:write',
  gnubok_list_expense_claims: 'suppliers:read',
  gnubok_get_expense_claim: 'suppliers:read',
  gnubok_create_expense_claim: 'suppliers:write',
  gnubok_delete_expense_claim: 'suppliers:write',
  gnubok_record_expense_payout: 'suppliers:write',
  gnubok_match_expense_payout: 'transactions:write',
  // Operation registry, wave 1: setup capabilities.
  gnubok_create_cash_account: 'companies:write',
  gnubok_update_cash_account: 'companies:write',
  gnubok_set_primary_cash_account: 'companies:write',
  gnubok_set_invoice_payee_default: 'companies:write',
  gnubok_change_bank_ledgers: 'companies:write',
  gnubok_create_fiscal_period: 'bookkeeping:write',
  gnubok_update_fiscal_period: 'bookkeeping:write',
  gnubok_close_fiscal_period_external: 'bookkeeping:write',
  gnubok_reopen_fiscal_period_external: 'bookkeeping:write',
  gnubok_delete_fiscal_period: 'bookkeeping:write',
  gnubok_delete_account: 'bookkeeping:write',
  gnubok_activate_accounts: 'bookkeeping:write',
  gnubok_deactivate_accounts: 'bookkeeping:write',
  gnubok_update_company_tax_profile: 'companies:write',
  gnubok_update_bookkeeping_lock: 'companies:write',
  gnubok_create_dimension:                'bookkeeping:write',
  gnubok_update_dimension:                'bookkeeping:write',
  gnubok_delete_dimension:                'bookkeeping:write',
  // Account dimension rules (operations dimension-rules.*).
  gnubok_list_dimension_rules:            'reports:read',
  gnubok_create_dimension_rule:           'bookkeeping:write',
  gnubok_update_dimension_rule:           'bookkeeping:write',
  gnubok_delete_dimension_rule:           'bookkeeping:write',
  // Budgets (operations budgets.* and reports.budget-vs-actual, accounted#134).
  gnubok_list_budgets:                    'reports:read',
  gnubok_get_budget:                      'reports:read',
  gnubok_budget_vs_actual:                'reports:read',
  gnubok_create_budget:                   'bookkeeping:write',
  gnubok_update_budget:                   'bookkeeping:write',
  gnubok_delete_budget:                   'bookkeeping:write',
  gnubok_upsert_budget_lines:             'bookkeeping:write',
  gnubok_copy_actuals_to_budget:          'bookkeeping:write',
  gnubok_spread_budget:                   'bookkeeping:write',
  // Retag history of posted lines (operation dimensions.retag-log).
  gnubok_list_dimension_retag_log:        'reports:read',
  gnubok_get_dimension_pnl:               'reports:read',
  // Resultat across two dimensions (operations reports.dimension-cross*, accounted#133).
  gnubok_get_dimension_cross:             'reports:read',
  gnubok_get_dimension_cross_lines:       'reports:read',
  // Staged bulk retag of posted-line dimensions (dimensions PR6).
  gnubok_tag_journal_lines:               'bookkeeping:write',
  // Document inbox
  gnubok_create_document_upload:          'transactions:write',
  gnubok_complete_document_upload:        'transactions:write',
  gnubok_upload_document:                 'transactions:write',
  gnubok_list_inbox_items:                'transactions:read',
  gnubok_get_inbox_item:                  'transactions:read',
  // The purchase-category taxonomy inbox items read as purchase_category.
  gnubok_list_purchase_categories:        'transactions:read',
  gnubok_list_unmatched_documents:        'transactions:read',
  gnubok_get_document_content:            'transactions:read',
  // Arkiv: the record behind documents, agreements and facts (reads), and
  // a staged fact proposal (write).
  gnubok_search_records:                  'documents:read',
  gnubok_get_record:                      'documents:read',
  gnubok_get_record_links:                'documents:read',
  gnubok_get_fact_history:                'documents:read',
  gnubok_get_source:                      'documents:read',
  gnubok_list_records:                    'documents:read',
  gnubok_read_document:                   'documents:read',
  gnubok_ask_document:                    'documents:read',
  gnubok_resolve_missing:                 'agent:write',
  gnubok_get_neighbourhood:               'documents:read',
  gnubok_propose_fact:                    'agent:write',
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
  gnubok_update_salary_run:               'payroll:write',
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
  gnubok_sie_import_status:              'reports:read',
  // Preflight is analysis, not a ledger write, and the byte-exact upload URL
  // only stages a file for it (documents bucket, 50 MB cap, two-hour TTL,
  // per-company pending prefix). A read key can therefore check a file
  // before anyone holds a write key; the ledger write stays the staged
  // gnubok_import_sie (Easy Online Stores evaluation, 2026-09-16).
  gnubok_sie_preflight:                   'reports:read',
  gnubok_create_sie_upload:               'reports:read',
  // Rot/rut begäran om utbetalning (records a payout request on generate)
  gnubok_generate_rot_rut_file:           'invoices:write',
  // Supplier CRUD
  gnubok_create_supplier:                 'suppliers:write',
  gnubok_update_supplier:                 'suppliers:write',
  gnubok_archive_supplier:                'suppliers:write',
  // Supplier invoice lifecycle
  gnubok_approve_supplier_invoice:        'suppliers:write',
  gnubok_credit_supplier_invoice:         'suppliers:write',
  gnubok_create_supplier_invoice_from_inbox: 'suppliers:write',
  gnubok_set_inbox_extracted_data:        'suppliers:write',
  // A supplier invoice already booked elsewhere (SIE) into the leverantörsreskontra: stages, books nothing
  gnubok_register_booked_supplier_invoice: 'suppliers:write',
  // Supplier invoice payment via existing verifikat (no new bokföring)
  gnubok_find_voucher_candidates_for_supplier_invoice: 'suppliers:read',
  gnubok_link_supplier_invoice_to_voucher: 'suppliers:write',
  // Invoice conversion + crediting
  gnubok_convert_invoice:                 'invoices:write',
  gnubok_set_quote_status:                'invoices:write',
  gnubok_cancel_quote_or_proforma:        'invoices:write',
  gnubok_credit_invoice:                  'invoices:write',
  gnubok_link_credit_note_to_invoice:     'invoices:write',
  // Phase 4: arbitrary-line bookkeeping primitives (high-risk, always staged)
  gnubok_create_voucher:                  'bookkeeping:write',
  gnubok_correct_entry:                   'bookkeeping:write',
  gnubok_reverse_journal_entry:           'bookkeeping:write',
  // Agent surface (Phase 6 MCP parity): briefing tool exposes company-specific
  // profile + memory so it's scoped; gnubok_list_skills / gnubok_load_skill
  // keep public discovery unscoped. The dispatcher gates own/ bodies, and
  // list_skills adds private company skills only with agent:read.
  gnubok_get_agent_briefing:              'agent:read',
  gnubok_get_task:                        'agent:read',
  // Agent memory write (previously UNMAPPED → callable by any key). Mapping to
  // agent:write; existing non-revoked keys are grandfathered in the
  // 20260619140000 migration so this does not regress them.
  gnubok_remember_fact:                   'agent:write',
  gnubok_forget_fact:                     'agent:write',
  gnubok_create_skill:                    'agent:write',
  // Pending operations approval (mirrors the /pending web UI)
  gnubok_list_pending_operations:         'pending_operations:read',
  gnubok_approve_pending_operation:       'pending_operations:approve',
  gnubok_approve_from_view:               'pending_operations:approve',
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
  // Rot/rut begäran history (status, beslut, settlement, refused share)
  gnubok_list_rot_rut_payout_requests:         'invoices:read',
  // Skatteverkets utbetalning: bank row booked against its begäran (stages)
  gnubok_settle_rot_rut_payout:                'transactions:write',
  // Existing payout verifikat linked to its begäran (stages, books nothing)
  gnubok_link_rot_rut_payout_voucher:          'invoices:write',
  // Anläggningsregister: reads ride reports:read (register data feeds the
  // depreciation proposal); writes are bookkeeping:write like the posting.
  gnubok_list_assets:                          'reports:read',
  gnubok_get_asset:                            'reports:read',
  gnubok_create_asset:                         'bookkeeping:write',
  gnubok_update_asset:                         'bookkeeping:write',
  gnubok_dispose_asset:                        'bookkeeping:write',
  gnubok_delete_asset:                         'bookkeeping:write',
  gnubok_list_verifikat_without_documents:     'transactions:read',
  gnubok_receipt_hunt_worklist:                'transactions:read',
  gnubok_find_voucher_candidates_for_invoice:  'invoices:read',
  gnubok_propose_dispositioner:                'reports:read',
  gnubok_propose_accruals:                     'reports:read',
  gnubok_propose_annual_depreciation:          'reports:read',
  gnubok_preview_arsredovisning:               'reports:read',
  gnubok_validate_arsredovisning:              'reports:read',
  gnubok_list_arsredovisning_versions:         'reports:read',
  gnubok_get_arsredovisning_filing_status:     'reports:read',
  gnubok_preview_ef_declaration:               'reports:read',
  // The underskottsregister, IL 40 kap. (lib/operations/tax-loss-carryforwards.ts).
  gnubok_list_tax_loss_carryforwards:          'reports:read',
  gnubok_get_tax_loss_carryforward:            'reports:read',
  gnubok_save_tax_loss_carryforward:           'bookkeeping:write',
}

/**
 * The tools that deliberately need no scope (available to any authenticated
 * key). Discovery, static skill bodies and the feedback channel stay open so
 * an agent can orient itself before its key's scopes are known; private skill
 * bodies are gated at dispatch. The two bridges carry no data of their own:
 * the dispatcher checks the scope of the tool they name.
 */
export const UNSCOPED_TOOLS: ReadonlySet<string> = new Set([
  'gnubok_search_tools',
  'gnubok_list_skills',
  'gnubok_load_skill',
  'gnubok_feedback',
  'gnubok_call_tool',
  'gnubok_stage_tool',
  // The stager takes its own staged operation back. Ownership is the gate
  // (lib/pending-operations/withdraw.ts): the operation must carry the
  // calling key as its stager, which proves the write scope it staged with.
  // No single scope fits, and pending_operations:approve must not be needed.
  'gnubok_withdraw_pending_operation',
])

/**
 * A scope a call needs on top of its TOOL_SCOPE_MAP entry, decided by the
 * call's arguments. gnubok_get_party reads a customer's party under
 * customers:read; through supplier_id, or a bare party_id that may be a
 * supplier's, it also needs suppliers:read.
 */
export function argumentScopeFor(toolName: string, args: Record<string, unknown>): ApiKeyScope | null {
  if (toolName === 'gnubok_get_party') {
    const given = (key: string) => typeof args[key] === 'string' && (args[key] as string).trim() !== ''
    return given('supplier_id') || given('party_id') ? 'suppliers:read' : null
  }
  if (toolName === 'gnubok_get_record') {
    const kind = typeof args.record_ref === 'string' ? args.record_ref.trim().split(':')[0] : ''
    return RECORD_KIND_SCOPES[kind] ?? null
  }
  return null
}

/**
 * gnubok_get_record opens a ledger record only under the scope of the tool
 * that reads it on its own: a documents:read key must not read a bank row or
 * an invoice through the archive. The kind is the record_ref prefix, which
 * these kinds require (a bare uuid resolves the archive kinds only).
 */
const RECORD_KIND_SCOPES: Record<string, ApiKeyScope> = {
  transaction: 'transactions:read',
  invoice: 'invoices:read',
  supplier_invoice: 'suppliers:read',
  skattekonto_transaction: 'reconciliation:read',
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
