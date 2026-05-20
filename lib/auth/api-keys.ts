import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'

const KEY_PREFIX = 'gnubok_sk_'
const REFRESH_TOKEN_PREFIX = 'gnubok_rt_'

// ── API Key Scopes ──────────────────────────────────────────

export const API_KEY_SCOPES = {
  'transactions:read':  { label: 'Transaktioner — läs',  description: 'Lista transaktioner, mallförslag, kategoriförslag (3 verktyg)' },
  'transactions:write': { label: 'Transaktioner — skriv', description: 'Kategorisera, av-kategorisera, kvittomatchning, koppling mot faktura (4 verktyg)' },
  'customers:read':     { label: 'Kunder — läs',         description: 'Lista kunder (1 verktyg)' },
  'customers:write':    { label: 'Kunder — skriv',       description: 'Skapa kunder (1 verktyg)' },
  'invoices:read':      { label: 'Fakturor — läs',       description: 'Lista fakturor (1 verktyg)' },
  'invoices:write':     { label: 'Fakturor — skriv',     description: 'Skapa, skicka, markera betald/skickad (4 verktyg)' },
  'suppliers:read':     { label: 'Leverantörer — läs',   description: 'Lista leverantörer och leverantörsfakturor (2 verktyg)' },
  'suppliers:write':    { label: 'Leverantörer — skriv', description: 'Godkänn och kreditera leverantörsfakturor (2 verktyg)' },
  'reports:read':       { label: 'Rapporter — läs',      description: 'Kontoplan, huvudbok, balansräkning, resultaträkning, moms, KPI, reskontra, perioder, bankavstämning, SIE-export (12 verktyg)' },
  'bookkeeping:write':  { label: 'Bokföring — skriv',    description: 'Stänga/låsa perioder, ingående balans, bokslut, SIE-import, voucher-gap-förklaringar' },
  'payroll:read':       { label: 'Löner — läs',          description: 'Lista anställda, lönekörningar, lönejournal (3 verktyg)' },
  'payroll:write':      { label: 'Löner — skriv',        description: 'Skapa lönekörning, beräkna, generera AGI (3 verktyg)' },
  // v1 REST API — added Phase 1
  'companies:read':     { label: 'Företag — läs',        description: 'Lista och visa företagsprofiler som API-nyckeln har tillgång till' },
  'events:read':        { label: 'Händelser — läs',      description: 'Polla händelseloggen (event_log) som webhook-fallback' },
  'webhooks:manage':    { label: 'Webhooks — hantera',   description: 'Skapa, lista, uppdatera och radera webhook-prenumerationer' },
  'operations:read':    { label: 'Operationer — läs',    description: 'Hämta status för långkörande operationer (importer, bokslut, omvärdering)' },
  'documents:read':     { label: 'Dokument — läs',       description: 'Lista och hämta dokumentbilagor' },
  'documents:write':    { label: 'Dokument — skriv',     description: 'Ladda upp och koppla dokument till verifikationer' },
  'compliance:read':    { label: 'Compliance — läs',     description: 'Pre-flight-kontroller: momsstängning, bokslutsberedskap, voucher-gap, IB/UB-kontinuitet' },
  'agent:read':         { label: 'Agent — läs',          description: 'Specialiserad bokföringsassistent: profil, laddade specialister/atomer, minnen (briefing + skill-katalog)' },
} as const

export type ApiKeyScope = keyof typeof API_KEY_SCOPES

export const ALL_SCOPES: ApiKeyScope[] = Object.keys(API_KEY_SCOPES) as ApiKeyScope[]

/** The read-only scopes assigned to keys with no explicit scopes (legacy/null). */
export const DEFAULT_SCOPES: ApiKeyScope[] = [
  'transactions:read',
  'customers:read',
  'invoices:read',
  'suppliers:read',
  'reports:read',
]

/** Scope domain groups for UI rendering */
export const SCOPE_GROUPS = [
  { domain: 'transactions', label: 'Transaktioner',  read: 'transactions:read' as const, write: 'transactions:write' as const },
  { domain: 'customers',    label: 'Kunder',         read: 'customers:read' as const,    write: 'customers:write' as const },
  { domain: 'invoices',     label: 'Fakturor',       read: 'invoices:read' as const,     write: 'invoices:write' as const },
  { domain: 'suppliers',    label: 'Leverantörer',   read: 'suppliers:read' as const,    write: 'suppliers:write' as const },
  { domain: 'reports',      label: 'Rapporter',      read: 'reports:read' as const,      write: null },
  { domain: 'bookkeeping',  label: 'Bokföring',      read: null,                          write: 'bookkeeping:write' as const },
  { domain: 'payroll',      label: 'Löner',          read: 'payroll:read' as const,      write: 'payroll:write' as const },
] as const

/** Map MCP tool name → required scope. Tools omitted from this map are available to any authenticated key (e.g. discovery/search/skill loading). */
export const TOOL_SCOPE_MAP: Record<string, ApiKeyScope> = {
  // Transactions
  gnubok_list_uncategorized_transactions:     'transactions:read',
  gnubok_list_transactions_without_documents: 'transactions:read',
  gnubok_create_transactions:                 'transactions:write',
  gnubok_categorize_transaction:              'transactions:write',
  gnubok_receipt_matcher:                     'transactions:write',
  gnubok_get_counterparty_templates:          'transactions:read',
  gnubok_suggest_categories:                  'transactions:read',
  gnubok_match_transaction_to_invoice:        'transactions:write',
  gnubok_auto_match_period:                   'transactions:write',
  // Customers
  gnubok_list_customers:                  'customers:read',
  gnubok_create_customer:                 'customers:write',
  // Invoices
  gnubok_list_invoices:                   'invoices:read',
  gnubok_create_invoice:                  'invoices:write',
  gnubok_send_invoice:                    'invoices:write',
  gnubok_mark_invoice_as_paid:            'invoices:write',
  gnubok_mark_invoice_as_sent:            'invoices:write',
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
  gnubok_get_balance_sheet:               'reports:read',
  gnubok_get_general_ledger:              'reports:read',
  gnubok_query_journal:                   'reports:read',
  gnubok_get_ar_ledger:                   'reports:read',
  gnubok_get_supplier_ledger:             'reports:read',
  gnubok_list_fiscal_periods:             'reports:read',
  gnubok_get_reconciliation_status:       'reports:read',
  // Document inbox
  gnubok_upload_document:                 'transactions:write',
  gnubok_list_inbox_items:                'transactions:read',
  gnubok_get_inbox_item:                  'transactions:read',
  gnubok_list_unmatched_documents:        'transactions:read',
  gnubok_get_document_content:            'transactions:read',
  gnubok_attach_document_to_transaction:  'transactions:write',
  // Payroll
  gnubok_list_employees:                  'payroll:read',
  gnubok_get_salary_run:                  'payroll:read',
  gnubok_get_salary_journal:              'payroll:read',
  gnubok_create_salary_run:               'payroll:write',
  gnubok_calculate_salary_run:            'payroll:write',
  gnubok_generate_agi:                    'payroll:write',
  // Bookkeeping write (Stream 1 Phase 1) — high-risk, always staged
  gnubok_close_period:                    'bookkeeping:write',
  gnubok_lock_period:                     'bookkeeping:write',
  gnubok_unlock_period:                   'bookkeeping:write',
  gnubok_run_year_end:                    'bookkeeping:write',
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
  // Supplier invoice lifecycle
  gnubok_approve_supplier_invoice:        'suppliers:write',
  gnubok_credit_supplier_invoice:         'suppliers:write',
  gnubok_create_supplier_invoice_from_inbox: 'suppliers:write',
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
  // registry — no per-company data).
  gnubok_get_agent_briefing:              'agent:read',
}

export function validateScopes(scopes: unknown): ApiKeyScope[] | null {
  if (scopes === null || scopes === undefined) return null
  if (!Array.isArray(scopes)) return null
  const valid = scopes.filter((s): s is ApiKeyScope => s in API_KEY_SCOPES)
  return valid.length > 0 ? valid : null
}

/**
 * Create a Supabase service client that doesn't require cookies.
 * Used for API key validation (MCP, webhooks) where there's no browser session.
 */
export function createServiceClientNoCookies() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const random = crypto.randomBytes(32).toString('base64url')
  const key = `${KEY_PREFIX}${random}`
  const hash = hashApiKey(key)
  const prefix = key.slice(0, KEY_PREFIX.length + 8)
  return { key, hash, prefix }
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

export function generateRefreshToken(): { token: string; hash: string } {
  const random = crypto.randomBytes(32).toString('base64url')
  const token = `${REFRESH_TOKEN_PREFIX}${random}`
  const hash = crypto.createHash('sha256').update(token).digest('hex')
  return { token, hash }
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function isRefreshToken(token: string): boolean {
  return token.startsWith(REFRESH_TOKEN_PREFIX)
}

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7)
}

/**
 * Validate an API key and enforce rate limiting.
 * Uses the DB RPC for atomic check + increment.
 * Returns the user_id, company_id, api_key_id, name, and effective scopes on
 * success, or an error with HTTP status.
 * null scopes in DB → DEFAULT_SCOPES (read-only).
 *
 * api_key_id and api_key_name are returned so callers (e.g. the MCP server)
 * can record actor attribution on pending_operations and audit_log.
 * They may be undefined when the deployed DB hasn't yet run the migration
 * that adds them to the RPC return shape.
 */
/**
 * Operating mode of the API key. 'live' keys see real company data; 'test' keys
 * are bound to deterministic sandbox companies. Keys created before the Phase 1
 * migration default to 'live' for backwards compatibility.
 */
export type ApiKeyMode = 'live' | 'test'

export async function validateApiKey(
  key: string
): Promise<
  | {
      userId: string
      companyId: string
      apiKeyId?: string
      apiKeyName?: string
      scopes: ApiKeyScope[]
      mode: ApiKeyMode
    }
  | { error: string; status: number }
> {
  if (isRefreshToken(key)) {
    return {
      error: 'Refresh token cannot be used as access token; exchange it at /api/mcp-oauth/token',
      status: 401,
    }
  }

  if (!key.startsWith(KEY_PREFIX)) {
    return { error: 'Invalid API key format', status: 401 }
  }

  const hash = hashApiKey(key)
  const supabase = createServiceClientNoCookies()

  const { data, error } = await supabase.rpc('validate_and_increment_api_key', {
    p_key_hash: hash,
  })

  if (error || !data || data.length === 0) {
    return { error: 'Invalid API key', status: 401 }
  }

  const row = data[0]

  if (row.rate_limited) {
    return { error: 'Rate limit exceeded', status: 429 }
  }

  return {
    userId: row.user_id,
    companyId: row.company_id,
    apiKeyId: row.api_key_id,
    apiKeyName: row.api_key_name,
    scopes: validateScopes(row.scopes) ?? DEFAULT_SCOPES,
    // `mode` may be undefined when the deployed DB hasn't yet run the Phase 1
    // migration that adds it to the RPC return. Default to 'live' so existing
    // keys behave unchanged.
    mode: (row.mode === 'test' ? 'test' : 'live') as ApiKeyMode,
  }
}

/**
 * Check if a given scope is allowed by the key's scopes.
 */
export function hasScope(keyScopes: ApiKeyScope[], required: ApiKeyScope): boolean {
  return keyScopes.includes(required)
}
