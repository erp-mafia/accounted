import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuditLogEntry } from '@/types'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchAppReleases, type AppReleaseRow } from '@/lib/reports/app-releases'
import {
  reportToWorkbook,
  textColumn,
  integerColumn,
  exportFilename,
  UTF8_BOM,
  type SheetSpec,
} from '@/lib/reports/xlsx-export'

/**
 * Behandlingshistorik (BFL 5 kap. 11 §, BFNAR 2013:2 punkt 9.16).
 *
 * The statutory processing history has two limbs:
 *
 *   (a) every bokföringspost that entered the system, with its
 *       registreringsdatum, in order, including corrections and who or what
 *       registered it; and
 *   (b) changes to the bookkeeping system that affect how posts are processed
 *       (kontoplan, settings such as redovisningsmetod or momsperiod, period
 *       locks, imports and migrations, access keys) and when they were made.
 *
 * This module is a read model over the stores that already record both limbs
 * (`journal_entries.committed_at` + the trigger-written immutable `audit_log`,
 * `journal_entry_rattelse_log`, `company_migration_resets`, `sie_imports`,
 * `bank_file_imports`) and turns them into one chronological list of
 * human-readable events. It never writes.
 *
 * Event labels are Swedish in both locales: the report is räkenskapsinformation
 * that is archived for seven years and handed to revisorer, the same rule as
 * the SIE export and the grundbok. UI chrome around it (column headers,
 * filters) is translated in the view.
 *
 * Scope rules:
 * - Fiscal-year mode (no date sub-range): the year's bokföringsposter are every
 *   posted/reversed entry of the fiscal period regardless of when it was
 *   committed (bokslut and storno entries land after period_end), plus every
 *   system change logged inside the period's dates. Audit rows touching the
 *   period's entries are included regardless of their timestamp.
 * - Date-range mode (a sub-range inside the fiscal year): what happened between
 *   those dates: entries committed in the window, audit rows logged in the
 *   window. No record-id union.
 */

// ============================================================
// Public types (shared with the client view via behandlingshistorik-types)
// ============================================================

import {
  BEHANDLINGSHISTORIK_CATEGORIES,
  BEHANDLINGSHISTORIK_CATEGORY_LABELS,
  type BehandlingshistorikActorType,
  type BehandlingshistorikCategory,
  type BehandlingshistorikEvent,
  type BehandlingshistorikReport,
  type BehandlingshistorikSource,
} from '@/lib/reports/behandlingshistorik-types'

export {
  BEHANDLINGSHISTORIK_CATEGORIES,
  BEHANDLINGSHISTORIK_CATEGORY_LABELS,
  type BehandlingshistorikActor,
  type BehandlingshistorikActorType,
  type BehandlingshistorikCategory,
  type BehandlingshistorikEvent,
  type BehandlingshistorikReport,
  type BehandlingshistorikSource,
} from '@/lib/reports/behandlingshistorik-types'

export interface BehandlingshistorikParams {
  periodId: string
  /** Inclusive ISO date; must lie inside the fiscal period (validated by the route). */
  fromDate?: string
  toDate?: string
  categories?: BehandlingshistorikCategory[]
}

/** Maps user ids to display labels (e-mail). Injected so the lib stays client-agnostic. */
export type UserLabelResolver = (userIds: string[]) => Promise<Map<string, string>>

export interface GenerateBehandlingshistorikOptions {
  resolveUserLabels?: UserLabelResolver
  appVersion?: string | null
  now?: Date
  /**
   * Service-role client for the global (company-less) system changes: the
   * statutory payroll constants' audit rows, which RLS hides from session
   * clients. Omit and those events are simply absent.
   */
  globalClient?: Pick<SupabaseClient, 'from'>
}

// ============================================================
// Internal row shapes
// ============================================================

interface PeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
}

interface EntryRow {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string | null
  source_type: string | null
  status: string
  committed_at: string | null
  user_id: string | null
  committed_actor_type: string | null
  committed_actor_label: string | null
  commit_method: string | null
  reverses_id: string | null
  correction_of_id: string | null
}

interface RattelseRow {
  id: string
  journal_entry_id: string
  rattelse_type: 'metadata' | 'lines'
  old_description: string | null
  new_description: string | null
  old_entry_date: string | null
  new_entry_date: string | null
  struck_lines: unknown
  added_lines: unknown
  actor: string | null
  created_at: string
}

interface MigrationResetRow {
  id: string
  source_company_id: string
  replacement_company_id: string
  actor_id: string | null
  reason: string | null
  source_counts: Record<string, unknown> | null
  created_at: string
}

interface SieImportRow {
  id: string
  user_id: string | null
  filename: string | null
  sie_type: number | string | null
  fiscal_year_start: string | null
  fiscal_year_end: string | null
  accounts_count: number | null
  transactions_count: number | null
  status: string | null
  error_message: string | null
  imported_at: string | null
  created_at: string
  replaced_at: string | null
}

interface BankFileImportRow {
  id: string
  user_id: string | null
  filename: string | null
  file_format: string | null
  transaction_count: number | null
  imported_count: number | null
  duplicate_count: number | null
  status: string | null
  error_message: string | null
  date_from: string | null
  date_to: string | null
  created_at: string
}

/** Event before user labels are resolved. */
interface RawActor {
  type: BehandlingshistorikActorType
  user_id: string | null
  actor_label: string | null
}

export interface RawBehandlingshistorikEvent extends Omit<BehandlingshistorikEvent, 'actor'> {
  actor: RawActor
}

// ============================================================
// Constants: tables, field labels, value labels
// ============================================================

/** audit_log tables the report reads. Everything else (registers) is out of scope per BFN's commentary. */
export const AUDITED_TABLES = [
  'journal_entries',
  'chart_of_accounts',
  'company_settings',
  'fiscal_periods',
  'api_keys',
  'dimensions',
  'dimension_values',
  'account_dimension_rules',
  'accrual_schedules',
  'document_attachments',
  // Behandlingsregler and import logs (audited since migration 20260901103000).
  'mapping_rules',
  'categorization_templates',
  'booking_template_library',
  'sie_imports',
  'bank_file_imports',
  // Verifikationsserie per bankkonto (audited since migration 20260902124513):
  // the per-account override outranks the per-source-type map above, so it is
  // a behandlingsregel in the same sense.
  'cash_accounts',
  // Which bank account customer invoices pay to, per currency (migration
  // 20260904010000).
  'invoice_payee_defaults',
] as const

/**
 * Global (company-less) audit rows: statutory payroll constants. RLS hides
 * NULL-company rows from session clients, so these are fetched through the
 * service role when the caller provides one (`globalClient`).
 */
export const GLOBAL_AUDITED_TABLES = ['salary_payroll_config'] as const

/** Actions that matter regardless of table (security / integrity / retention). */
export const GLOBAL_ACTIONS = [
  'SECURITY_EVENT',
  'INTEGRITY_FAILURE',
  'RETENTION_BLOCK',
  'DOCUMENT_DELETE_BLOCKED',
] as const

/**
 * PostgREST `or` filter selecting the rows above. Written as one literal so the
 * schema guard (tests/schema/no-phantom-columns.test.ts) can resolve the column
 * names statically; a unit test pins it to AUDITED_TABLES / GLOBAL_ACTIONS.
 */
export const AUDIT_ROW_FILTER =
  'table_name.in.(journal_entries,chart_of_accounts,company_settings,fiscal_periods,api_keys,dimensions,dimension_values,account_dimension_rules,accrual_schedules,document_attachments,mapping_rules,categorization_templates,booking_template_library,sie_imports,bank_file_imports,cash_accounts,invoice_payee_defaults),action.in.(SECURITY_EVENT,INTEGRITY_FAILURE,RETENTION_BLOCK,DOCUMENT_DELETE_BLOCKED)'

const SOURCE_TYPE_LABELS: Record<string, string> = {
  manual: 'Manuell',
  import: 'Import',
  bank_transaction: 'Banktransaktion',
  storno: 'Storno',
  correction: 'Rättelse',
  supplier_invoice_registered: 'Leverantörsfaktura registrerad',
  supplier_invoice_paid: 'Leverantörsfaktura betald',
  supplier_invoice_privately_paid: 'Leverantörsfaktura privat betald',
  supplier_invoice_cash_payment: 'Leverantörsfaktura kontant',
  supplier_credit_note: 'Leverantörskreditnota',
  opening_balance: 'Ingående balans',
  system: 'System',
  salary_payment: 'Lön',
  inbox_item: 'Underlag från inkorg',
  invoice_created: 'Kundfaktura',
  invoice_paid: 'Kundfaktura betald',
  invoice_cash_payment: 'Kontantfaktura',
  credit_note: 'Kreditfaktura',
  result_appropriation: 'Resultatdisposition',
  year_end: 'Bokslut',
  vat_settlement: 'Momsavräkning',
  accrual: 'Periodisering',
  currency_revaluation: 'Valutaomvärdering',
  webshop_order: 'Webshop',
  stripe_payout: 'Stripe-utbetalning',
}

const COMMIT_METHOD_LABELS: Record<string, string> = {
  user_accept: 'Godkänd av användare',
  bulk_accept: 'Godkänd i massbokning',
  api_key: 'Via API-nyckel',
  agent_relay: 'Godkänd via assistenten',
}

const JOURNAL_ENTRY_FIELDS: Record<string, string> = {
  description: 'Beskrivning',
  entry_date: 'Datum',
  notes: 'Notering',
  attachment_urls: 'Underlag',
  voucher_series: 'Verifikationsserie',
  voucher_number: 'Verifikationsnummer',
  fiscal_period_id: 'Räkenskapsår',
  status: 'Status',
}

const ACCOUNT_FIELDS: Record<string, string> = {
  account_name: 'Namn',
  account_type: 'Typ',
  is_active: 'Aktivt',
  default_vat_code: 'Momskod',
  default_vat_rate: 'Momssats',
  default_vat_treatment: 'Momshantering',
  sru_code: 'SRU-kod',
  k2_excluded: 'Exkluderat i K2',
  description: 'Beskrivning',
}

/**
 * company_settings keys that affect how bokföringsposter are processed
 * (BFNAR 2013:2 p. 9.16 second paragraph). Everything else on the row
 * (invoice layout, onboarding state, running counters) is deliberately ignored:
 * next_invoice_number alone would otherwise add a row per issued invoice.
 */
const SETTINGS_FIELDS: Record<string, string> = {
  accounting_method: 'Redovisningsmetod',
  moms_period: 'Momsperiod',
  vat_registered: 'Momsregistrerad',
  vat_filing_method: 'Momsdeklaration, inlämningssätt',
  vat_has_eu_trade: 'EU-handel',
  vat_taxable_base_over_40m: 'Beskattningsunderlag över 40 mkr',
  tax_turnover_over_40m: 'Omsättning över 40 mkr',
  fiscal_year_start_month: 'Räkenskapsårets startmånad',
  default_voucher_series: 'Standardserie för verifikat',
  default_voucher_series_per_source_type: 'Verifikationsserier per källa',
  bookkeeping_locked_through: 'Bokföringen låst till och med',
  auto_lock_period_days: 'Automatisk låsning (dagar)',
  defer_invoice_booking: 'Bokför kundfakturor vid betalning',
  ore_rounding: 'Öresavrundning',
  rot_rut_enabled: 'ROT/RUT',
  oss_enabled: 'OSS',
  ioss_enabled: 'IOSS',
  employer_registered: 'Registrerad arbetsgivare',
  employer_seasonal: 'Säsongsarbetsgivare',
  pays_salaries: 'Betalar löner',
  has_employees: 'Har anställda',
  employee_count: 'Antal anställda',
  salary_pay_day: 'Löneutbetalningsdag',
  salary_vacation_year_basis: 'Semesterår',
  salary_net_rounding: 'Avrundning nettolön',
  salary_default_bank: 'Standardbank för lön',
  kontrolluppgifter_enabled: 'Kontrolluppgifter',
  fyllnadsinbetalning_enabled: 'Fyllnadsinbetalning',
  preliminary_tax_monthly: 'Preliminärskatt per månad',
  entity_type: 'Företagsform',
  org_number: 'Organisationsnummer',
  company_name: 'Företagsnamn',
  country: 'Land',
  f_skatt: 'F-skatt',
  periodisk_sammanstallning_enabled: 'Periodisk sammanställning',
  periodisk_sammanstallning_period: 'Periodisk sammanställning, period',
  periodisk_sammanstallning_filing_method: 'Periodisk sammanställning, inlämningssätt',
  punktskatt_enabled: 'Punktskatt',
  intrastat_enabled: 'Intrastat',
  dimensions_enabled: 'Dimensioner',
  invoice_payment_accounts: 'Betalkonton för kundfakturor',
  last_supplier_payment_account: 'Standardkonto för leverantörsbetalning',
  schablon_mileage_rate: 'Milersättning (schablon)',
  mileage_enabled: 'Körjournal',
  selected_modules: 'Aktiverade moduler',
  uses_pos_system: 'Kassaregister',
  aktiekapital: 'Aktiekapital',
  antal_aktier: 'Antal aktier',
  is_sandbox: 'Sandlåda',
}

const SETTINGS_VALUE_LABELS: Record<string, Record<string, string>> = {
  // company_settings CHECK allows 'accrual' | 'cash'; 'invoice' is the legacy spelling.
  accounting_method: { accrual: 'Faktureringsmetoden', invoice: 'Faktureringsmetoden', cash: 'Kontantmetoden' },
  moms_period: { monthly: 'Månad', quarterly: 'Kvartal', yearly: 'Helår', none: 'Ingen' },
  entity_type: { aktiebolag: 'Aktiebolag', enskild_firma: 'Enskild firma' },
}

const PERIOD_FIELDS: Record<string, string> = {
  name: 'Namn',
  period_start: 'Startdatum',
  period_end: 'Slutdatum',
  opening_balances_set: 'Ingående balanser satta',
  continuity_verified: 'Kontinuitet verifierad',
  tax_depreciation_method: 'Skattemässig avskrivning, metod',
  tax_depreciation_rule: 'Skattemässig avskrivning, regel',
  tax_depreciation_base: 'Skattemässig avskrivning, underlag',
  tax_depreciation_deduction: 'Skattemässig avskrivning, avdrag',
}

const API_KEY_FIELDS: Record<string, string> = {
  name: 'Namn',
  scopes: 'Behörigheter',
  rate_limit_per_minute: 'Anrop per minut',
  expires_at: 'Giltig till',
  is_active: 'Aktiv',
  // How much the key may post without a human. A change here changes who
  // approves the company's bookkeeping, so it belongs in behandlingshistorik
  // (BFL 5 kap. 11 §) exactly like a scope change does. Without this line the
  // UPDATE row exists in audit_log but renders zero diff lines and is dropped.
  unattended_commit_limit: 'Belopp utan mänsklig granskning',
}

const DIMENSION_FIELDS: Record<string, string> = {
  name: 'Namn',
  code: 'Kod',
  is_active: 'Aktiv',
  dimension_type: 'Typ',
  sie_dimension_number: 'SIE-dimension',
}

const MAPPING_RULE_FIELDS: Record<string, string> = {
  rule_name: 'Namn',
  rule_type: 'Typ',
  priority: 'Prioritet',
  merchant_pattern: 'Motpartsmönster',
  description_pattern: 'Textmönster',
  mcc_codes: 'MCC-koder',
  amount_min: 'Belopp från',
  amount_max: 'Belopp till',
  debit_account: 'Debetkonto',
  credit_account: 'Kreditkonto',
  vat_treatment: 'Momshantering',
  vat_debit_account: 'Momskonto debet',
  vat_credit_account: 'Momskonto kredit',
  capitalization_threshold: 'Aktiveringsgräns',
  capitalized_debit_account: 'Konto vid aktivering',
  requires_review: 'Kräver granskning',
  default_private: 'Privat som standard',
  is_active: 'Aktiv',
}

/**
 * cash_accounts columns that are behandlingsregler. Only voucher_series: the
 * trigger (20260902124513) fires on that column alone, and the read model
 * must not resurrect balance/name churn from bank sync if a row slips through.
 */
const CASH_ACCOUNT_FIELDS: Record<string, string> = {
  voucher_series: 'Verifikationsserie',
  // Payee fields (migration 20260904010000): what customer invoices print.
  bank_name: 'Bank',
  clearing_number: 'Clearingnummer',
  account_number: 'Kontonummer',
  bankgiro: 'Bankgiro',
  plusgiro: 'Plusgiro',
  swish: 'Swish',
  iban: 'IBAN',
  bic: 'BIC/SWIFT',
  bank_code: 'Bankkod',
  foreign_account_number: 'Kontonummer (utländskt)',
  invoice_payee: 'Visas på kundfakturor',
}

const INVOICE_PAYEE_DEFAULT_FIELDS: Record<string, string> = {
  cash_account_id: 'Bankkonto',
}

const CATEGORIZATION_TEMPLATE_FIELDS: Record<string, string> = {
  counterparty_name: 'Motpart',
  // counterparty_aliases deliberately absent: aliases grow in the same
  // learning write as occurrence_count (migration 20260901200000 stopped
  // logging them), and the pre-fix audit rows already in prod are alias-only
  // noise that must render as no-ops, not as rule changes.
  debit_account: 'Debetkonto',
  credit_account: 'Kreditkonto',
  vat_treatment: 'Momshantering',
  vat_account: 'Momskonto',
  category: 'Kategori',
  line_pattern: 'Radmönster',
  default_dimensions: 'Dimensioner',
  is_active: 'Aktiv',
}

const BOOKING_TEMPLATE_FIELDS: Record<string, string> = {
  name: 'Namn',
  description: 'Beskrivning',
  category: 'Kategori',
  entity_type: 'Företagsform',
  lines: 'Konteringsrader',
  is_active: 'Aktiv',
}

/** Keys of salary_payroll_config that are bookkeeping constants (all but bookkeeping of the row itself). */
const PAYROLL_CONFIG_EXCLUDED_KEYS = new Set(['id', 'created_at'])

const ACCRUAL_FIELDS: Record<string, string> = {
  description: 'Beskrivning',
  status: 'Status',
  total_amount: 'Belopp',
  start_date: 'Startdatum',
  end_date: 'Slutdatum',
  periods: 'Antal perioder',
  balance_account: 'Balanskonto',
  result_account: 'Resultatkonto',
}

/**
 * Event codes whose consecutive runs (same actor, short gap) collapse into one
 * summary row: kontoplan seeding writes ~1 000 rows, and a receipt clean-up
 * deletes dozens of underlag in one go.
 */
interface CollapseRule {
  minSize: number
  event: string
  noun: string
  category: BehandlingshistorikCategory
  mode: 'accounts' | 'documents'
}

const COLLAPSIBLE: Record<string, CollapseRule> = {
  'account.created': { minSize: 10, event: 'Kontoplan upplagd', noun: 'konton', category: 'kontoplan', mode: 'accounts' },
  'account.updated': { minSize: 10, event: 'Kontoplan ändrad', noun: 'konton', category: 'kontoplan', mode: 'accounts' },
  'account.deleted': { minSize: 10, event: 'Konton borttagna ur kontoplanen', noun: 'konton', category: 'kontoplan', mode: 'accounts' },
  'document.deleted': { minSize: 3, event: 'Underlag borttagna', noun: 'underlag', category: 'ovrigt', mode: 'documents' },
}

const MAX_VALUE_LENGTH = 80

// ============================================================
// Small helpers
// ============================================================

function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? value : new Date(ms).toISOString()
}

function toMs(value: string | null | undefined): number {
  if (!value) return Number.NaN
  return Date.parse(value)
}

function isWithin(value: string | null | undefined, fromMs: number, toMs: number): boolean {
  const ms = Date.parse(value ?? '')
  return !Number.isNaN(ms) && ms >= fromMs && ms <= toMs
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH - 1)}…` : value
}

function fmtValue(value: unknown, key?: string): string {
  if (value === null || value === undefined || value === '') return '(tomt)'
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nej'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    const mapped = key ? SETTINGS_VALUE_LABELS[key]?.[value] : undefined
    return truncate(mapped ?? value)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '(tomt)'
    return truncate(value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', '))
  }
  if (typeof value === 'object') {
    // Settings maps such as default_voucher_series_per_source_type read better
    // as "import: A, manual: A" than as raw JSON.
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '(tomt)'
    return truncate(
      entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', '),
    )
  }
  return truncate(JSON.stringify(value))
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * Field-level diff restricted to an allow-list of labelled keys. Returns one
 * "Label: old → new" line per changed key, in allow-list order.
 */
export function diffFields(
  oldState: Record<string, unknown> | null,
  newState: Record<string, unknown> | null,
  labels: Record<string, string>,
): { lines: string[]; keys: string[] } {
  const lines: string[] = []
  const keys: string[] = []
  for (const key of Object.keys(labels)) {
    const before = oldState ? oldState[key] : undefined
    const after = newState ? newState[key] : undefined
    if (same(before, after)) continue
    keys.push(key)
    lines.push(`${labels[key]}: ${fmtValue(before, key)} → ${fmtValue(after, key)}`)
  }
  return { lines, keys }
}

function voucherLabel(series: unknown, number: unknown): string | null {
  if (number === null || number === undefined) return null
  return `${typeof series === 'string' ? series : ''}${String(number)}`
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function sourceTypeLabel(sourceType: string | null | undefined): string {
  if (!sourceType) return 'Okänd'
  return SOURCE_TYPE_LABELS[sourceType] ?? sourceType
}

function normaliseActorType(value: unknown): BehandlingshistorikActorType {
  switch (value) {
    case 'api_key':
    case 'mcp_oauth':
    case 'cron':
    case 'agent_chat':
    case 'system':
      return value
    default:
      return 'user'
  }
}

function actorKey(actor: RawActor): string {
  return `${actor.type}|${actor.user_id ?? ''}|${actor.actor_label ?? ''}`
}

/** Resolve a raw actor into the display label shown in the report. */
export function formatActorLabel(actor: RawActor, userLabels: Map<string, string>): string {
  const userLabel = actor.user_id ? userLabels.get(actor.user_id) : undefined
  const fallbackUser = actor.user_id ? `Användare ${actor.user_id.slice(0, 8)}` : null
  switch (actor.type) {
    case 'api_key':
      return actor.actor_label ? `API-nyckel: ${actor.actor_label}` : 'API-nyckel'
    case 'mcp_oauth':
      return actor.actor_label ? `MCP-anslutning: ${actor.actor_label}` : 'MCP-anslutning'
    case 'agent_chat': {
      const who = userLabel ?? fallbackUser
      return who ? `Assistenten, på uppdrag av ${who}` : 'Assistenten'
    }
    case 'cron':
      return actor.actor_label ? `Schemalagd körning: ${actor.actor_label}` : 'Schemalagd körning'
    case 'system':
      return actor.actor_label ? `Systemet: ${actor.actor_label}` : 'Systemet'
    default:
      return userLabel ?? fallbackUser ?? 'Okänd användare'
  }
}

function finaliseEvent(
  raw: RawBehandlingshistorikEvent,
  userLabels: Map<string, string>,
): BehandlingshistorikEvent {
  return {
    ...raw,
    actor: {
      type: raw.actor.type,
      user_id: raw.actor.user_id,
      label: formatActorLabel(raw.actor, userLabels),
    },
  }
}

// ============================================================
// Normalisers: one source row → zero or one event
// ============================================================

interface NormaliseContext {
  /** journal_entry_id → committed metadata-rättelse timestamps (ms), to suppress the duplicate audit UPDATE row. */
  rattelseMetadataAt: Map<string, number[]>
  entryById: Map<string, EntryRow>
}

const RATTELSE_DUPLICATE_WINDOW_MS = 30_000

/** A posted or reversed entry, i.e. a real bokföringspost. */
function isBookedStatus(status: unknown): boolean {
  return status === 'posted' || status === 'reversed'
}

export function commitEventFromEntry(entry: EntryRow): RawBehandlingshistorikEvent | null {
  if (!isBookedStatus(entry.status) || !entry.committed_at) return null
  const details: string[] = [`Datum: ${entry.entry_date}`]
  if (entry.description) details.push(`Text: ${truncate(entry.description)}`)
  details.push(`Källa: ${sourceTypeLabel(entry.source_type)}`)
  if (entry.commit_method) {
    details.push(`Bokföringssätt: ${COMMIT_METHOD_LABELS[entry.commit_method] ?? entry.commit_method}`)
  }
  if (entry.reverses_id) details.push('Vändningsverifikation (storno)')
  if (entry.correction_of_id) details.push('Rättelseverifikation')
  const actorType = entry.committed_actor_type
    ? normaliseActorType(entry.committed_actor_type)
    : entry.commit_method === 'api_key'
      ? 'api_key'
      : 'user'
  return {
    id: `entry:${entry.id}`,
    occurred_at: toIso(entry.committed_at)!,
    category: 'verifikation',
    code: 'journal_entry.committed',
    event: 'Verifikation bokförd',
    object: voucherLabel(entry.voucher_series, entry.voucher_number),
    actor: { type: actorType, user_id: entry.user_id, actor_label: entry.committed_actor_label },
    details,
    source: 'journal_entries',
    count: 1,
  }
}

function describeLine(line: unknown): string {
  if (!line || typeof line !== 'object') return String(line)
  const l = line as Record<string, unknown>
  const account = str(l.account_number) ?? '?'
  const debit = num(l.debit_amount) ?? 0
  const credit = num(l.credit_amount) ?? 0
  const amount = debit > 0 ? `D ${fmtAmount(debit)}` : `K ${fmtAmount(credit)}`
  return `${account} ${amount}`
}

function fmtAmount(value: number): string {
  return value.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function rattelseEvent(
  row: RattelseRow,
  entryById: Map<string, EntryRow>,
): RawBehandlingshistorikEvent {
  const entry = entryById.get(row.journal_entry_id)
  const details: string[] = []
  if (row.rattelse_type === 'metadata') {
    if (!same(row.old_description, row.new_description)) {
      details.push(`Beskrivning: ${fmtValue(row.old_description)} → ${fmtValue(row.new_description)}`)
    }
    if (!same(row.old_entry_date, row.new_entry_date)) {
      details.push(`Datum: ${fmtValue(row.old_entry_date)} → ${fmtValue(row.new_entry_date)}`)
    }
  } else {
    const struck = Array.isArray(row.struck_lines) ? row.struck_lines : []
    const added = Array.isArray(row.added_lines) ? row.added_lines : []
    if (struck.length > 0) details.push(`Strukna rader (${struck.length}): ${struck.map(describeLine).join('; ')}`)
    if (added.length > 0) details.push(`Tillagda rader (${added.length}): ${added.map(describeLine).join('; ')}`)
  }
  return {
    id: `rattelse:${row.id}`,
    occurred_at: toIso(row.created_at)!,
    category: 'verifikation',
    code: row.rattelse_type === 'lines' ? 'journal_entry.corrected_lines' : 'journal_entry.corrected_metadata',
    event:
      row.rattelse_type === 'lines'
        ? 'Verifikation rättad i samma verifikat (rader)'
        : 'Verifikation rättad i samma verifikat (text/datum)',
    object: entry ? voucherLabel(entry.voucher_series, entry.voucher_number) : null,
    actor: { type: 'user', user_id: row.actor, actor_label: null },
    details,
    source: 'rattelse_log',
    count: 1,
  }
}

function baseAuditActor(row: AuditLogEntry): RawActor {
  return {
    type: normaliseActorType(row.actor_type),
    user_id: row.user_id ?? row.actor_id ?? null,
    actor_label: row.actor_label ?? null,
  }
}

function auditEvent(
  row: AuditLogEntry,
  fields: {
    category: BehandlingshistorikCategory
    code: string
    event: string
    object: string | null
    details?: string[]
    actor?: RawActor
  },
): RawBehandlingshistorikEvent {
  return {
    id: `audit:${row.id}`,
    occurred_at: toIso(row.created_at)!,
    category: fields.category,
    code: fields.code,
    event: fields.event,
    object: fields.object,
    actor: fields.actor ?? baseAuditActor(row),
    details: fields.details ?? [],
    source: 'audit_log',
    count: 1,
  }
}

function journalEntryAuditEvent(
  row: AuditLogEntry,
  ctx: NormaliseContext,
): RawBehandlingshistorikEvent | null {
  const oldState = row.old_state
  const newState = row.new_state
  const state = newState ?? oldState
  const object = voucherLabel(state?.voucher_series, state?.voucher_number)

  switch (row.action) {
    case 'COMMIT':
      // The bokföringspost itself is emitted from journal_entries (complete,
      // incl. entries predating the audit log). Nothing to add here.
      return null
    case 'REVERSE':
      return auditEvent(row, {
        category: 'verifikation',
        code: 'journal_entry.reversed',
        event: 'Verifikation makulerad (storno)',
        object,
        details: ['Bokförd verifikation vänd med en vändningsverifikation'],
      })
    case 'DELETE':
      if (!isBookedStatus(oldState?.status)) return null
      return auditEvent(row, {
        category: 'verifikation',
        code: 'journal_entry.deleted',
        event: 'Bokförd verifikation raderad',
        object,
        details: [`Datum: ${fmtValue(oldState?.entry_date)}`, `Text: ${fmtValue(oldState?.description)}`],
      })
    case 'RESET_SNAPSHOT': {
      // reset_fiscal_year archives the full verifikat content (accounts,
      // amounts, line text) in a company-scoped row before deleting; the
      // trigger's DELETE row that follows carries only the header.
      const rawLines = oldState?.lines
      const lineDetails = Array.isArray(rawLines)
        ? rawLines.map((raw) => {
            const line = raw as Record<string, unknown>
            return `${str(line.account_number) ?? '?'}: debet ${fmtValue(line.debit_amount)}, kredit ${fmtValue(line.credit_amount)}`
          })
        : []
      return auditEvent(row, {
        category: 'verifikation',
        code: 'journal_entry.reset_snapshot',
        event: 'Verifikationsinnehåll arkiverat inför nollställning',
        object,
        details: [
          `Datum: ${fmtValue(oldState?.entry_date)}`,
          `Text: ${fmtValue(oldState?.description)}`,
          ...lineDetails,
        ],
      })
    }
    case 'COMMITTED_AT_OVERRIDE':
      return auditEvent(row, {
        category: 'verifikation',
        code: 'journal_entry.committed_at_override',
        event: 'Registreringstidpunkt förinställd av systemkörning',
        object: object ?? (row.record_id ? `Verifikat ${row.record_id.slice(0, 8)}` : null),
        details: [
          `Förinställd tidpunkt: ${fmtValue(newState?.preset_committed_at)}`,
          `Verklig tidpunkt: ${fmtValue(newState?.wall_clock)}`,
          `Databasroll: ${fmtValue(newState?.jwt_role)}`,
        ],
      })
    case 'UPDATE': {
      if (!isBookedStatus(oldState?.status) && !isBookedStatus(newState?.status)) return null
      const { lines, keys } = diffFields(oldState, newState, JOURNAL_ENTRY_FIELDS)
      if (lines.length === 0) return null
      // A metadata rättelse writes both a rättelse-log row (true actor) and the
      // trigger's UPDATE row (entry owner as user_id). Keep the rättelse row.
      const onlyRattelseKeys = keys.every((k) => k === 'description' || k === 'entry_date')
      if (onlyRattelseKeys && row.record_id) {
        const stamps = ctx.rattelseMetadataAt.get(row.record_id) ?? []
        const at = toMs(row.created_at)
        if (stamps.some((s) => Math.abs(s - at) <= RATTELSE_DUPLICATE_WINDOW_MS)) return null
      }
      return auditEvent(row, {
        category: 'verifikation',
        code: 'journal_entry.updated',
        event: 'Verifikation ändrad',
        object,
        details: lines,
      })
    }
    default:
      return null
  }
}

function accountAuditEvent(row: AuditLogEntry): RawBehandlingshistorikEvent | null {
  const state = row.new_state ?? row.old_state
  const number = str(state?.account_number)
  const name = str(state?.account_name)
  const object = number ? `${number}${name ? ` ${name}` : ''}` : null
  switch (row.action) {
    case 'INSERT': {
      const details: string[] = []
      const type = str(state?.account_type)
      if (type) details.push(`Typ: ${type}`)
      const vat = str(state?.default_vat_code)
      if (vat) details.push(`Momskod: ${vat}`)
      return auditEvent(row, { category: 'kontoplan', code: 'account.created', event: 'Konto tillagt', object, details })
    }
    case 'UPDATE': {
      const { lines } = diffFields(row.old_state, row.new_state, ACCOUNT_FIELDS)
      if (lines.length === 0) return null
      return auditEvent(row, { category: 'kontoplan', code: 'account.updated', event: 'Konto ändrat', object, details: lines })
    }
    case 'DELETE':
      return auditEvent(row, { category: 'kontoplan', code: 'account.deleted', event: 'Konto borttaget', object })
    default:
      return null
  }
}

function settingsAuditEvent(row: AuditLogEntry): RawBehandlingshistorikEvent | null {
  switch (row.action) {
    case 'INSERT': {
      const s = row.new_state
      const details: string[] = []
      if (s?.entity_type) details.push(`Företagsform: ${fmtValue(s.entity_type, 'entity_type')}`)
      if (s?.accounting_method) details.push(`Redovisningsmetod: ${fmtValue(s.accounting_method, 'accounting_method')}`)
      if (s?.moms_period) details.push(`Momsperiod: ${fmtValue(s.moms_period, 'moms_period')}`)
      return auditEvent(row, {
        category: 'installningar',
        code: 'settings.created',
        event: 'Företagsinställningar skapade',
        object: str(s?.company_name),
        details,
      })
    }
    case 'UPDATE': {
      const { lines } = diffFields(row.old_state, row.new_state, SETTINGS_FIELDS)
      if (lines.length === 0) return null
      return auditEvent(row, {
        category: 'installningar',
        code: 'settings.updated',
        event: 'Företagsinställningar ändrade',
        object: null,
        details: lines,
      })
    }
    case 'DELETE':
      return auditEvent(row, {
        category: 'installningar',
        code: 'settings.deleted',
        event: 'Företagsinställningar raderade',
        object: str(row.old_state?.company_name),
      })
    default:
      return null
  }
}

function periodAuditEvent(row: AuditLogEntry): RawBehandlingshistorikEvent | null {
  const state = row.new_state ?? row.old_state
  const name = str(state?.name)
  const span =
    str(state?.period_start) && str(state?.period_end)
      ? `${state?.period_start} till ${state?.period_end}`
      : null
  const object = name ?? span
  switch (row.action) {
    case 'INSERT':
      return auditEvent(row, {
        category: 'period',
        code: 'period.created',
        event: 'Räkenskapsår skapat',
        object,
        details: span ? [span] : [],
      })
    case 'LOCK_PERIOD':
      return auditEvent(row, { category: 'period', code: 'period.locked', event: 'Räkenskapsår låst', object })
    case 'CLOSE_PERIOD':
      return auditEvent(row, {
        category: 'period',
        code: 'period.closed',
        event: 'Räkenskapsår stängt (bokslut)',
        object,
      })
    case 'DELETE':
      return auditEvent(row, { category: 'period', code: 'period.deleted', event: 'Räkenskapsår raderat', object })
    case 'UPDATE': {
      const oldState = row.old_state
      const newState = row.new_state
      // App-written unlock rows carry only { locked_at } in both states.
      if (oldState?.locked_at && !newState?.locked_at) {
        return auditEvent(row, {
          category: 'period',
          code: 'period.unlocked',
          event: 'Räkenskapsår upplåst',
          object: object ?? (row.description?.replace(/^Period unlocked: /, '') || null),
        })
      }
      if (newState?.closed_externally && !oldState?.closed_externally) {
        return auditEvent(row, {
          category: 'period',
          code: 'period.closed_externally',
          event: 'Räkenskapsår markerat som stängt i tidigare system',
          object: object ?? (row.description?.replace(/^Period marked as closed in previous system: /, '') || null),
        })
      }
      if (!oldState?.locked_at && newState?.locked_at) {
        return auditEvent(row, { category: 'period', code: 'period.locked', event: 'Räkenskapsår låst', object })
      }
      if (!oldState?.is_closed && newState?.is_closed) {
        return auditEvent(row, {
          category: 'period',
          code: 'period.closed',
          event: 'Räkenskapsår stängt (bokslut)',
          object,
        })
      }
      const { lines } = diffFields(oldState, newState, PERIOD_FIELDS)
      if (lines.length === 0) return null
      return auditEvent(row, {
        category: 'period',
        code: 'period.updated',
        event: 'Räkenskapsår ändrat',
        object,
        details: lines,
      })
    }
    default:
      return null
  }
}

function apiKeyAuditEvent(row: AuditLogEntry): RawBehandlingshistorikEvent | null {
  const state = row.new_state ?? row.old_state
  const object = str(state?.name) ?? str(state?.key_prefix) ?? null
  switch (row.action) {
    case 'INSERT': {
      const details: string[] = []
      const scopes = state?.scopes
      if (Array.isArray(scopes) && scopes.length > 0) details.push(`Behörigheter: ${fmtValue(scopes)}`)
      if (state?.expires_at) details.push(`Giltig till: ${fmtValue(state.expires_at)}`)
      return auditEvent(row, { category: 'atkomst', code: 'api_key.created', event: 'API-nyckel skapad', object, details })
    }
    case 'UPDATE': {
      if (!row.old_state?.revoked_at && row.new_state?.revoked_at) {
        return auditEvent(row, { category: 'atkomst', code: 'api_key.revoked', event: 'API-nyckel återkallad', object })
      }
      const { lines } = diffFields(row.old_state, row.new_state, API_KEY_FIELDS)
      if (lines.length === 0) return null
      return auditEvent(row, { category: 'atkomst', code: 'api_key.updated', event: 'API-nyckel ändrad', object, details: lines })
    }
    case 'DELETE':
      return auditEvent(row, { category: 'atkomst', code: 'api_key.deleted', event: 'API-nyckel raderad', object })
    default:
      return null
  }
}

function genericAuditEvent(
  row: AuditLogEntry,
  opts: { category: BehandlingshistorikCategory; codePrefix: string; noun: string; fields: Record<string, string>; objectKeys: string[] },
): RawBehandlingshistorikEvent | null {
  const state = row.new_state ?? row.old_state
  let object: string | null = null
  for (const key of opts.objectKeys) {
    const v = str(state?.[key])
    if (v) {
      object = object ? `${object} ${v}` : v
    }
  }
  switch (row.action) {
    case 'INSERT':
      return auditEvent(row, { category: opts.category, code: `${opts.codePrefix}.created`, event: `${opts.noun} skapad`, object })
    case 'UPDATE': {
      const { lines } = diffFields(row.old_state, row.new_state, opts.fields)
      if (lines.length === 0) return null
      return auditEvent(row, { category: opts.category, code: `${opts.codePrefix}.updated`, event: `${opts.noun} ändrad`, object, details: lines })
    }
    case 'DELETE':
      return auditEvent(row, { category: opts.category, code: `${opts.codePrefix}.deleted`, event: `${opts.noun} borttagen`, object })
    default:
      return null
  }
}

function globalActionEvent(row: AuditLogEntry): RawBehandlingshistorikEvent | null {
  const labels: Record<string, { code: string; event: string }> = {
    SECURITY_EVENT: { code: 'security.event', event: 'Säkerhetshändelse' },
    INTEGRITY_FAILURE: { code: 'integrity.failure', event: 'Integritetskontroll misslyckades' },
    RETENTION_BLOCK: { code: 'retention.blocked', event: 'Radering stoppad av arkiveringskravet' },
    DOCUMENT_DELETE_BLOCKED: { code: 'document.delete_blocked', event: 'Radering av underlag stoppad' },
  }
  const meta = labels[row.action]
  if (!meta) return null
  return auditEvent(row, {
    category: 'ovrigt',
    code: meta.code,
    event: meta.event,
    object: row.table_name ?? null,
    details: row.description ? [row.description] : [],
  })
}

/** One audit_log row → zero or one behandlingshistorik event. Exported for tests. */
export function auditRowToEvent(
  row: AuditLogEntry,
  ctx: NormaliseContext = { rattelseMetadataAt: new Map(), entryById: new Map() },
): RawBehandlingshistorikEvent | null {
  if ((GLOBAL_ACTIONS as readonly string[]).includes(row.action)) return globalActionEvent(row)
  switch (row.table_name) {
    case 'journal_entries':
      return journalEntryAuditEvent(row, ctx)
    case 'chart_of_accounts':
      return accountAuditEvent(row)
    case 'company_settings':
      return settingsAuditEvent(row)
    case 'fiscal_periods':
      return periodAuditEvent(row)
    case 'api_keys':
      return apiKeyAuditEvent(row)
    case 'dimensions':
      return genericAuditEvent(row, {
        category: 'installningar',
        codePrefix: 'dimension',
        noun: 'Dimension',
        fields: DIMENSION_FIELDS,
        objectKeys: ['name'],
      })
    case 'dimension_values':
      return genericAuditEvent(row, {
        category: 'installningar',
        codePrefix: 'dimension_value',
        noun: 'Dimensionsvärde',
        fields: DIMENSION_FIELDS,
        objectKeys: ['code', 'name'],
      })
    case 'account_dimension_rules':
      return genericAuditEvent(row, {
        category: 'installningar',
        codePrefix: 'dimension_rule',
        noun: 'Dimensionsregel',
        fields: { requirement: 'Krav', account_from: 'Konto från', account_to: 'Konto till' },
        objectKeys: ['account_from', 'account_to'],
      })
    case 'accrual_schedules':
      return genericAuditEvent(row, {
        category: 'installningar',
        codePrefix: 'accrual_schedule',
        noun: 'Periodiseringsplan',
        fields: ACCRUAL_FIELDS,
        objectKeys: ['description'],
      })
    case 'document_attachments':
      if (row.action !== 'DELETE') return null
      return auditEvent(row, {
        category: 'ovrigt',
        code: 'document.deleted',
        event: 'Underlag borttaget',
        object: str(row.old_state?.file_name),
      })
    // Behandlingsregler (BFNAR 2013:2 p. 9.9 / 9.16 second paragraph).
    case 'mapping_rules':
      return genericAuditEvent(row, {
        category: 'installningar',
        codePrefix: 'mapping_rule',
        noun: 'Konteringsregel',
        fields: MAPPING_RULE_FIELDS,
        objectKeys: ['rule_name'],
      })
    case 'categorization_templates':
      return genericAuditEvent(row, {
        category: 'installningar',
        codePrefix: 'categorization_template',
        noun: 'Konteringsmall för motpart',
        fields: CATEGORIZATION_TEMPLATE_FIELDS,
        objectKeys: ['counterparty_name'],
      })
    case 'booking_template_library':
      return genericAuditEvent(row, {
        category: 'installningar',
        codePrefix: 'booking_template',
        noun: 'Konteringsmall',
        fields: BOOKING_TEMPLATE_FIELDS,
        objectKeys: ['name'],
      })
    case 'cash_accounts':
      return genericAuditEvent(row, {
        category: 'installningar',
        codePrefix: 'cash_account',
        noun: 'Bankkonto',
        fields: CASH_ACCOUNT_FIELDS,
        objectKeys: ['name', 'ledger_account'],
      })
    case 'invoice_payee_defaults':
      return genericAuditEvent(row, {
        category: 'installningar',
        codePrefix: 'invoice_payee_default',
        noun: 'Standardkonto för kundfakturor',
        fields: INVOICE_PAYEE_DEFAULT_FIELDS,
        // Both keys on every action: a created or deleted default must name
        // the account, not just the currency.
        objectKeys: ['currency', 'cash_account_id'],
      })
    case 'salary_payroll_config':
      return payrollConfigAuditEvent(row)
    // The import tables emit their own events from the rows themselves; the
    // audit trail only adds what the rows can no longer show: a deletion.
    case 'sie_imports':
      if (row.action !== 'DELETE') return null
      return auditEvent(row, {
        category: 'import',
        code: 'sie_import.deleted',
        event: 'SIE-importlogg raderad',
        object: str(row.old_state?.filename),
      })
    case 'bank_file_imports':
      if (row.action !== 'DELETE') return null
      return auditEvent(row, {
        category: 'import',
        code: 'bank_file_import.deleted',
        event: 'Bankfilsimport raderad',
        object: str(row.old_state?.filename),
      })
    default:
      return null
  }
}

/**
 * Statutory payroll constants (arbetsgivaravgifter, prisbasbelopp, ...):
 * exactly BFN's "procentsats för automatkontering av sociala avgifter"
 * example. Global rows (no company), one per config year.
 */
function payrollConfigAuditEvent(row: AuditLogEntry): RawBehandlingshistorikEvent | null {
  const state = row.new_state ?? row.old_state
  const year = state?.config_year
  const object = year !== undefined && year !== null ? `Löneår ${String(year)}` : null
  const actor: RawActor = {
    type: row.actor_type && row.actor_type !== 'user' ? normaliseActorType(row.actor_type) : row.user_id ? 'user' : 'system',
    user_id: row.user_id ?? null,
    actor_label: row.actor_label ?? null,
  }
  switch (row.action) {
    case 'INSERT':
      return auditEvent(row, {
        category: 'installningar',
        code: 'payroll_config.created',
        event: 'Lönekonstanter tillagda (arbetsgivaravgifter, basbelopp, schabloner)',
        object,
        actor,
      })
    case 'UPDATE': {
      const keys = Object.keys({ ...(row.old_state ?? {}), ...(row.new_state ?? {}) })
        .filter((k) => !PAYROLL_CONFIG_EXCLUDED_KEYS.has(k))
        .sort()
      const labels = Object.fromEntries(keys.map((k) => [k, k]))
      const { lines } = diffFields(row.old_state, row.new_state, labels)
      if (lines.length === 0) return null
      return auditEvent(row, {
        category: 'installningar',
        code: 'payroll_config.updated',
        event: 'Lönekonstanter ändrade',
        object,
        details: lines,
        actor,
      })
    }
    case 'DELETE':
      return auditEvent(row, {
        category: 'installningar',
        code: 'payroll_config.deleted',
        event: 'Lönekonstanter borttagna',
        object,
        actor,
      })
    default:
      return null
  }
}

function migrationResetEvent(row: MigrationResetRow, companyId: string): RawBehandlingshistorikEvent {
  const isSource = row.source_company_id === companyId
  const details: string[] = []
  if (row.reason) details.push(`Skäl: ${truncate(row.reason)}`)
  if (row.source_counts && typeof row.source_counts === 'object') {
    const parts = Object.entries(row.source_counts)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `${k}: ${v}`)
    if (parts.length > 0) details.push(`Omfattning: ${truncate(parts.join(', '))}`)
  }
  return {
    id: `reset:${row.id}`,
    occurred_at: toIso(row.created_at)!,
    category: 'import',
    code: isSource ? 'migration.reset_archived' : 'migration.reset_started',
    event: isSource
      ? 'Bokföringen arkiverad inför ny migrering'
      : 'Nytt bokföringsunderlag startat efter återställning',
    object: null,
    actor: { type: 'user', user_id: row.actor_id, actor_label: null },
    details,
    source: 'migration_reset',
    count: 1,
  }
}

function sieImportEvents(row: SieImportRow): RawBehandlingshistorikEvent[] {
  const events: RawBehandlingshistorikEvent[] = []
  const actor: RawActor = { type: 'user', user_id: row.user_id, actor_label: null }
  const details: string[] = []
  if (row.sie_type !== null && row.sie_type !== undefined) details.push(`Filtyp: SIE${row.sie_type}`)
  if (row.fiscal_year_start && row.fiscal_year_end) details.push(`Räkenskapsår: ${row.fiscal_year_start} till ${row.fiscal_year_end}`)
  if (typeof row.accounts_count === 'number' || typeof row.transactions_count === 'number') {
    details.push(`${row.accounts_count ?? 0} konton, ${row.transactions_count ?? 0} transaktioner`)
  }
  // undo_sie_import sets status = 'undone' + replaced_at: the import did
  // complete, and was later reversed (the entry deletions carry their own
  // audit rows).
  const undone = row.status === 'undone'
  const completed = row.status === 'completed' || undone
  const failed = row.status === 'failed'
  events.push({
    id: `sie:${row.id}`,
    occurred_at: toIso(completed ? (row.imported_at ?? row.created_at) : row.created_at)!,
    category: 'import',
    code: completed ? 'sie_import.completed' : failed ? 'sie_import.failed' : 'sie_import.started',
    event: completed ? 'SIE-fil importerad' : failed ? 'SIE-import misslyckades' : 'SIE-import påbörjad',
    object: row.filename,
    actor,
    details: failed && row.error_message ? [...details, `Fel: ${truncate(row.error_message)}`] : details,
    source: 'sie_import',
    count: 1,
  })
  if (row.replaced_at) {
    events.push({
      id: `sie:${row.id}:replaced`,
      occurred_at: toIso(row.replaced_at)!,
      category: 'import',
      code: undone ? 'sie_import.undone' : 'sie_import.replaced',
      event: undone ? 'SIE-import ångrad (importerade verifikationer raderade)' : 'SIE-import ersatt av ny import',
      object: row.filename,
      actor,
      details: [],
      source: 'sie_import',
      count: 1,
    })
  }
  return events
}

function bankFileImportEvent(row: BankFileImportRow): RawBehandlingshistorikEvent {
  const failed = row.status === 'failed'
  const details: string[] = []
  if (row.file_format) details.push(`Format: ${row.file_format}`)
  if (typeof row.transaction_count === 'number') {
    details.push(
      `${row.imported_count ?? 0} av ${row.transaction_count} transaktioner importerade` +
        (row.duplicate_count ? `, ${row.duplicate_count} dubbletter` : ''),
    )
  }
  if (row.date_from && row.date_to) details.push(`Kontoutdrag: ${row.date_from} till ${row.date_to}`)
  if (failed && row.error_message) details.push(`Fel: ${truncate(row.error_message)}`)
  return {
    id: `bankfile:${row.id}`,
    occurred_at: toIso(row.created_at)!,
    category: 'import',
    code: failed ? 'bank_file_import.failed' : 'bank_file_import.completed',
    event: failed ? 'Bankfilsimport misslyckades' : 'Bankfil importerad',
    object: row.filename,
    actor: { type: 'user', user_id: row.user_id, actor_label: null },
    details,
    source: 'bank_file_import',
    count: 1,
  }
}

/** A program version first seen in production (app_releases): p. 9.16 "nya programversioner". */
export function appReleaseEvent(row: AppReleaseRow): RawBehandlingshistorikEvent {
  return {
    id: `release:${row.version}`,
    occurred_at: toIso(row.first_seen_at)!,
    category: 'ovrigt',
    code: 'system.release',
    event: 'Ny programversion i drift',
    object: row.version,
    actor: { type: 'system', user_id: null, actor_label: null },
    details: [row.source === 'runtime' ? 'Registrerad av systemet när versionen började svara' : `Källa: ${row.source}`],
    source: 'audit_log',
    count: 1,
  }
}

const STOCKHOLM_DAY = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * Program versions, rolled up per calendar day.
 *
 * A single event per version is not viable: main takes ~570 merges a month, so
 * a fiscal year is on the order of 7 000 deploys, which alone would exceed the
 * PDF's 4 000-event guard and bury the ~400 events a real company's year
 * actually contains. The statutory unit is the date ("när dessa förändringar
 * infördes", p. 9.16), not the build id, and the qualifier in the same sentence
 * is "förändringar ... som påverkar bokföringsposternas behandling", which a
 * deploy list cannot distinguish anyway. So the day is the event and the build
 * ids are its detail; app_releases keeps the per-version truth for anyone who
 * needs to go deeper.
 */
export function appReleaseEvents(rows: AppReleaseRow[]): RawBehandlingshistorikEvent[] {
  const byDay = new Map<string, AppReleaseRow[]>()
  for (const row of rows) {
    const iso = toIso(row.first_seen_at)
    if (!iso) continue
    const day = STOCKHOLM_DAY.format(new Date(iso))
    const bucket = byDay.get(day)
    if (bucket) bucket.push(row)
    else byDay.set(day, [row])
  }

  const out: RawBehandlingshistorikEvent[] = []
  for (const [day, group] of byDay) {
    if (group.length === 1) {
      out.push(appReleaseEvent(group[0]))
      continue
    }
    // Every build id, not the usual five-plus-"och N till": the point of the
    // entry is that an auditor can reconstruct which versions ran that day, and
    // a truncated list defeats it. A day is bounded by the deploy rate (~19),
    // so this stays one readable cell.
    const versions = group.map((r) => r.version)
    out.push({
      id: `release:${day}:bulk`,
      occurred_at: toIso(group[0].first_seen_at)!,
      category: 'ovrigt',
      code: 'system.release.bulk',
      event: 'Nya programversioner i drift',
      object: `${versions.length} versioner`,
      actor: { type: 'system', user_id: null, actor_label: null },
      details: [versions.join(', ')],
      source: 'audit_log',
      count: versions.length,
    })
  }
  return out
}

/**
 * Audit rows for the global tables (no company_id): only reachable with the
 * service role, which the route supplies. Windowed on created_at.
 */
async function fetchGlobalAuditRows(
  client: Pick<SupabaseClient, 'from'>,
  window: { fromTs: string; toTs: string },
): Promise<AuditLogEntry[]> {
  return fetchAllRows<AuditLogEntry>(({ from, to }) =>
    client
      .from('audit_log')
      .select('*')
      .is('company_id', null)
      .in('table_name', [...GLOBAL_AUDITED_TABLES])
      .gte('created_at', window.fromTs)
      .lte('created_at', window.toTs)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
}

// ============================================================
// Ordering and burst collapse
// ============================================================

const SOURCE_ORDER: Record<BehandlingshistorikSource, number> = {
  journal_entries: 0,
  audit_log: 1,
  rattelse_log: 2,
  migration_reset: 3,
  sie_import: 4,
  bank_file_import: 5,
}

export function sortEvents<T extends { occurred_at: string; source: BehandlingshistorikSource; id: string }>(
  events: T[],
): T[] {
  return [...events].sort((a, b) => {
    const ta = toMs(a.occurred_at)
    const tb = toMs(b.occurred_at)
    if (ta !== tb) return ta - tb
    const sa = SOURCE_ORDER[a.source]
    const sb = SOURCE_ORDER[b.source]
    if (sa !== sb) return sa - sb
    return a.id.localeCompare(b.id)
  })
}

export interface CollapseOptions {
  /** Runs shorter than this are kept as individual events. */
  minSize?: number
  /** Max gap between consecutive rows of one run. */
  gapMs?: number
}

/**
 * Chart-of-accounts seeding and bulk maintenance write one audit row per
 * account (a BAS kontoplan is ~1 000 rows), and a receipt clean-up deletes
 * many underlag at once. Consecutive events of a collapsible code by the same
 * actor within a short gap collapse into one summary event ("Kontoplan
 * upplagd: 41 konton") so the report reads as what happened, not as a wall of
 * rows. Input must already be sorted by occurred_at.
 */
export function collapseBursts(
  events: RawBehandlingshistorikEvent[],
  options: CollapseOptions = {},
): RawBehandlingshistorikEvent[] {
  const gapMs = options.gapMs ?? 120_000
  const out: RawBehandlingshistorikEvent[] = []
  let run: RawBehandlingshistorikEvent[] = []

  const flush = () => {
    if (run.length === 0) return
    const rule = COLLAPSIBLE[run[0].code]
    const minSize = options.minSize ?? rule.minSize
    if (run.length < minSize) {
      out.push(...run)
    } else {
      out.push(summariseRun(run, rule))
    }
    run = []
  }

  for (const ev of events) {
    if (!COLLAPSIBLE[ev.code]) {
      flush()
      out.push(ev)
      continue
    }
    const prev = run[run.length - 1]
    const continues =
      prev &&
      prev.code === ev.code &&
      actorKey(prev.actor) === actorKey(ev.actor) &&
      toMs(ev.occurred_at) - toMs(prev.occurred_at) <= gapMs
    if (!continues) flush()
    run.push(ev)
  }
  flush()
  return out
}

/** @deprecated name kept for readers of the first revision; use collapseBursts. */
export const collapseAccountBursts = collapseBursts

const MAX_LISTED_OBJECTS = 5

function summariseRun(run: RawBehandlingshistorikEvent[], rule: CollapseRule): RawBehandlingshistorikEvent {
  const first = run[0]
  const details: string[] = []
  if (rule.mode === 'accounts') {
    const numbers = run
      .map((e) => (e.object ? e.object.split(' ')[0] : ''))
      .filter((n) => n.length > 0)
      .sort()
    if (numbers.length > 0) details.push(`Konton ${numbers[0]} till ${numbers[numbers.length - 1]}`)
    if (first.code === 'account.updated') {
      const changed = new Set<string>()
      for (const e of run) for (const d of e.details) changed.add(d.split(':')[0])
      if (changed.size > 0) details.push(`Ändrade fält: ${[...changed].join(', ')}`)
    }
  } else {
    const names = [...new Set(run.map((e) => e.object).filter((o): o is string => !!o))]
    if (names.length > 0) {
      const listed = names.slice(0, MAX_LISTED_OBJECTS).join(', ')
      const rest = names.length - MAX_LISTED_OBJECTS
      details.push(rest > 0 ? `${listed} och ${rest} till` : listed)
    }
  }
  return {
    id: `${first.id}:bulk`,
    occurred_at: first.occurred_at,
    category: rule.category,
    code: `${first.code}.bulk`,
    event: rule.event,
    object: `${run.length} ${rule.noun}`,
    actor: first.actor,
    details,
    source: 'audit_log',
    count: run.length,
  }
}

// ============================================================
// Fetchers
// ============================================================

const ID_CHUNK = 200

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function fetchPeriod(supabase: SupabaseClient, companyId: string, periodId: string): Promise<PeriodRow | null> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Failed to fetch fiscal period: ${error.message}`)
  return (data as PeriodRow | null) ?? null
}

async function fetchCompany(supabase: SupabaseClient, companyId: string): Promise<{ name: string; org_number: string | null }> {
  const { data } = await supabase
    .from('company_settings')
    .select('company_name, org_number')
    .eq('company_id', companyId)
    .maybeSingle()
  const row = data as { company_name?: string | null; org_number?: string | null } | null
  return { name: row?.company_name ?? '', org_number: row?.org_number ?? null }
}

async function fetchPeriodEntries(supabase: SupabaseClient, companyId: string, periodId: string): Promise<EntryRow[]> {
  return fetchAllRows<EntryRow>(({ from, to }) =>
    supabase
      .from('journal_entries')
      .select(
        'id, voucher_series, voucher_number, entry_date, description, source_type, status, committed_at, user_id, committed_actor_type, committed_actor_label, commit_method, reverses_id, correction_of_id',
      )
      .eq('company_id', companyId)
      .eq('fiscal_period_id', periodId)
      .order('id', { ascending: true })
      .range(from, to),
  )
}

async function fetchAuditRows(
  supabase: SupabaseClient,
  companyId: string,
  window: { fromTs: string; toTs: string },
  recordIds: string[],
): Promise<AuditLogEntry[]> {
  const byId = new Map<string, AuditLogEntry>()

  const windowed = await fetchAllRows<AuditLogEntry>(({ from, to }) =>
    supabase
      .from('audit_log')
      .select('*')
      .eq('company_id', companyId)
      .gte('created_at', window.fromTs)
      .lte('created_at', window.toTs)
      // Literal on purpose (not AUDIT_ROW_FILTER): the schema guard only
      // resolves string literals here. A test pins the two to each other.
      .or(
        'table_name.in.(journal_entries,chart_of_accounts,company_settings,fiscal_periods,api_keys,dimensions,dimension_values,account_dimension_rules,accrual_schedules,document_attachments,mapping_rules,categorization_templates,booking_template_library,sie_imports,bank_file_imports,cash_accounts,invoice_payee_defaults),action.in.(SECURITY_EVENT,INTEGRITY_FAILURE,RETENTION_BLOCK,DOCUMENT_DELETE_BLOCKED)',
      )
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  for (const row of windowed) byId.set(row.id, row)

  for (const ids of chunk(recordIds, ID_CHUNK)) {
    const rows = await fetchAllRows<AuditLogEntry>(({ from, to }) =>
      supabase
        .from('audit_log')
        .select('*')
        .eq('company_id', companyId)
        .eq('table_name', 'journal_entries')
        .in('record_id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const row of rows) byId.set(row.id, row)
  }
  return [...byId.values()]
}

async function fetchRattelseRows(
  supabase: SupabaseClient,
  companyId: string,
  window: { fromTs: string; toTs: string },
  entryIds: string[],
): Promise<RattelseRow[]> {
  const byId = new Map<string, RattelseRow>()
  const windowed = await fetchAllRows<RattelseRow>(({ from, to }) =>
    supabase
      .from('journal_entry_rattelse_log')
      .select('*')
      .eq('company_id', companyId)
      .gte('created_at', window.fromTs)
      .lte('created_at', window.toTs)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  for (const row of windowed) byId.set(row.id, row)
  for (const ids of chunk(entryIds, ID_CHUNK)) {
    const rows = await fetchAllRows<RattelseRow>(({ from, to }) =>
      supabase
        .from('journal_entry_rattelse_log')
        .select('*')
        .eq('company_id', companyId)
        .in('journal_entry_id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const row of rows) byId.set(row.id, row)
  }
  return [...byId.values()]
}

async function fetchMigrationResets(supabase: SupabaseClient, companyId: string): Promise<MigrationResetRow[]> {
  // Two equality queries instead of one `.or()`: the reset row is relevant to
  // both the archived source company and its replacement, and the schema guard
  // resolves plain column filters statically.
  const byId = new Map<string, MigrationResetRow>()
  const asSource = await supabase
    .from('company_migration_resets')
    .select('id, source_company_id, replacement_company_id, actor_id, reason, source_counts, created_at')
    .eq('source_company_id', companyId)
    .order('created_at', { ascending: true })
  if (asSource.error) throw new Error(`Failed to fetch migration resets: ${asSource.error.message}`)
  const asReplacement = await supabase
    .from('company_migration_resets')
    .select('id, source_company_id, replacement_company_id, actor_id, reason, source_counts, created_at')
    .eq('replacement_company_id', companyId)
    .order('created_at', { ascending: true })
  if (asReplacement.error) throw new Error(`Failed to fetch migration resets: ${asReplacement.error.message}`)
  for (const row of [
    ...((asSource.data as MigrationResetRow[] | null) ?? []),
    ...((asReplacement.data as MigrationResetRow[] | null) ?? []),
  ]) {
    byId.set(row.id, row)
  }
  return [...byId.values()]
}

async function fetchSieImports(supabase: SupabaseClient, companyId: string): Promise<SieImportRow[]> {
  return fetchAllRows<SieImportRow>(({ from, to }) =>
    supabase
      .from('sie_imports')
      .select(
        'id, user_id, filename, sie_type, fiscal_year_start, fiscal_year_end, accounts_count, transactions_count, status, error_message, imported_at, created_at, replaced_at',
      )
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to),
  )
}

async function fetchBankFileImports(supabase: SupabaseClient, companyId: string): Promise<BankFileImportRow[]> {
  return fetchAllRows<BankFileImportRow>(({ from, to }) =>
    supabase
      .from('bank_file_imports')
      .select(
        'id, user_id, filename, file_format, transaction_count, imported_count, duplicate_count, status, error_message, date_from, date_to, created_at',
      )
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to),
  )
}

/**
 * Resolve user ids to e-mail labels through `profiles`. `profiles` RLS is
 * self-only, so the caller passes a service-role client; the lookup is scoped
 * to exactly the ids that appear in the report.
 */
export async function resolveUserLabelsFromProfiles(
  serviceClient: Pick<SupabaseClient, 'from'>,
  userIds: string[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>()
  for (const ids of chunk(userIds, ID_CHUNK)) {
    const { data } = await serviceClient.from('profiles').select('id, email, full_name').in('id', ids)
    for (const row of (data as { id: string; email: string | null; full_name: string | null }[] | null) ?? []) {
      const label = row.email || row.full_name
      if (label) labels.set(row.id, label)
    }
  }
  return labels
}

// ============================================================
// Generator
// ============================================================

export async function generateBehandlingshistorik(
  supabase: SupabaseClient,
  companyId: string,
  params: BehandlingshistorikParams,
  options: GenerateBehandlingshistorikOptions = {},
): Promise<BehandlingshistorikReport | null> {
  const period = await fetchPeriod(supabase, companyId, params.periodId)
  if (!period) return null
  const company = await fetchCompany(supabase, companyId)

  const mode: BehandlingshistorikReport['mode'] = params.fromDate || params.toDate ? 'date_range' : 'fiscal_year'
  const from = params.fromDate ?? period.period_start
  const to = params.toDate ?? period.period_end
  const fromTs = `${from}T00:00:00.000Z`
  const toTs = `${to}T23:59:59.999Z`
  const fromMs = Date.parse(fromTs)
  const toMsBound = Date.parse(toTs)
  const window = { fromTs, toTs }

  const entries = await fetchPeriodEntries(supabase, companyId, period.id)
  const entryById = new Map(entries.map((e) => [e.id, e]))
  const entryIds = entries.map((e) => e.id)
  const unionIds = mode === 'fiscal_year' ? entryIds : []

  const [auditRows, rattelseRows, resets, sieImports, bankImports, releases, globalAuditRows] = await Promise.all([
    fetchAuditRows(supabase, companyId, window, unionIds),
    fetchRattelseRows(supabase, companyId, window, unionIds),
    fetchMigrationResets(supabase, companyId),
    fetchSieImports(supabase, companyId),
    fetchBankFileImports(supabase, companyId),
    fetchAppReleases(supabase, window),
    options.globalClient ? fetchGlobalAuditRows(options.globalClient, window) : Promise.resolve([] as AuditLogEntry[]),
  ])

  const raw: RawBehandlingshistorikEvent[] = []

  // System-wide changes (p. 9.16 second paragraph): program versions and the
  // statutory payroll constants, dated by when they entered production.
  raw.push(...appReleaseEvents(releases))
  for (const row of globalAuditRows) {
    const ev = auditRowToEvent(row)
    if (ev) raw.push(ev)
  }

  // (a) bokföringsposter: from journal_entries, the complete source.
  for (const entry of entries) {
    if (mode === 'date_range' && !isWithin(entry.committed_at, fromMs, toMsBound)) continue
    const ev = commitEventFromEntry(entry)
    if (ev) raw.push(ev)
  }

  // Rättelser, with an index so the duplicate trigger row can be suppressed.
  const rattelseMetadataAt = new Map<string, number[]>()
  for (const row of rattelseRows) {
    if (row.rattelse_type === 'metadata') {
      const list = rattelseMetadataAt.get(row.journal_entry_id) ?? []
      list.push(toMs(row.created_at))
      rattelseMetadataAt.set(row.journal_entry_id, list)
    }
    raw.push(rattelseEvent(row, entryById))
  }

  const ctx: NormaliseContext = { rattelseMetadataAt, entryById }
  for (const row of auditRows) {
    const ev = auditRowToEvent(row, ctx)
    if (ev) raw.push(ev)
  }

  // (b) imports and migrations: filtered to the window in code (small tables).
  for (const row of resets) {
    if (isWithin(row.created_at, fromMs, toMsBound)) raw.push(migrationResetEvent(row, companyId))
  }
  for (const row of sieImports) {
    for (const ev of sieImportEvents(row)) {
      if (isWithin(ev.occurred_at, fromMs, toMsBound)) raw.push(ev)
    }
  }
  for (const row of bankImports) {
    if (isWithin(row.created_at, fromMs, toMsBound)) raw.push(bankFileImportEvent(row))
  }

  let events = collapseBursts(sortEvents(raw))
  if (params.categories && params.categories.length > 0) {
    const wanted = new Set(params.categories)
    events = events.filter((e) => wanted.has(e.category))
  }

  const userIds = [...new Set(events.map((e) => e.actor.user_id).filter((id): id is string => !!id))]
  const userLabels = options.resolveUserLabels && userIds.length > 0
    ? await options.resolveUserLabels(userIds)
    : new Map<string, string>()
  const finalEvents = events.map((e) => finaliseEvent(e, userLabels))

  const byCategory = Object.fromEntries(
    BEHANDLINGSHISTORIK_CATEGORIES.map((c) => [c, 0]),
  ) as Record<BehandlingshistorikCategory, number>
  for (const e of finalEvents) byCategory[e.category] += 1

  return {
    company,
    period: { id: period.id, name: period.name, start: period.period_start, end: period.period_end },
    range: { from, to },
    mode,
    generated_at: (options.now ?? new Date()).toISOString(),
    app_version: options.appVersion ?? null,
    total_events: finalEvents.length,
    by_category: byCategory,
    events: finalEvents,
    category_filter: params.categories && params.categories.length > 0 ? [...params.categories] : null,
  }
}

// ============================================================
// Export (xlsx / csv)
// ============================================================

const STOCKHOLM_FORMAT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/** `2026-08-21 10:15:03` in Swedish local time. Falls back to the input when unparseable. */
export function formatStockholmTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return STOCKHOLM_FORMAT.format(d).replace(',', '')
}

export function behandlingshistorikSheetSpecs(report: BehandlingshistorikReport): SheetSpec<unknown>[] {
  const events: SheetSpec<BehandlingshistorikEvent> = {
    name: 'Behandlingshistorik',
    columns: [
      textColumn('Tidpunkt'),
      textColumn('Kategori'),
      textColumn('Händelse'),
      textColumn('Objekt'),
      textColumn('Utförd av'),
      textColumn('Detaljer'),
      textColumn('Kod'),
      integerColumn('Antal'),
    ],
    rows: report.events,
    mapRow: (e) => [
      formatStockholmTimestamp(e.occurred_at),
      BEHANDLINGSHISTORIK_CATEGORY_LABELS[e.category],
      e.event,
      e.object,
      e.actor.label,
      e.details.join(' | '),
      e.code,
      e.count,
    ],
  }
  const meta: SheetSpec<[string, string]> = {
    name: 'Rapport',
    columns: [textColumn('Uppgift'), textColumn('Värde')],
    rows: [
      ['Rapport', 'Behandlingshistorik (BFL 5 kap. 11 §, BFNAR 2013:2 p. 9.16)'],
      ['Företag', report.company.name],
      ['Organisationsnummer', report.company.org_number ?? ''],
      ['Räkenskapsår', `${report.period.name} (${report.period.start} till ${report.period.end})`],
      ['Urval', report.mode === 'fiscal_year' ? 'Hela räkenskapsåret' : `${report.range.from} till ${report.range.to}`],
      ['Antal händelser', String(report.total_events)],
      ['Genererad', formatStockholmTimestamp(report.generated_at)],
      ['Programversion', report.app_version ?? 'okänd'],
      ['Tidszon', 'Europe/Stockholm'],
    ],
    mapRow: (r) => [r[0], r[1]],
  }
  return [events as SheetSpec<unknown>, meta as SheetSpec<unknown>]
}

export function buildBehandlingshistorikExport(
  report: BehandlingshistorikReport,
  format: 'xlsx' | 'csv',
): { buffer: Buffer; contentType: string; filename: string } {
  const specs = behandlingshistorikSheetSpecs(report)
  const date = report.mode === 'fiscal_year' ? report.period.end : report.range.to
  if (format === 'csv') {
    // CSV carries the first sheet only; the metadata sheet is xlsx-only.
    const buf = reportToWorkbook([specs[0]], { bookType: 'csv' })
    // SheetJS already emits a UTF-8 BOM for csv in current versions; only add
    // one when it is missing so Excel never sees a doubled mark in cell A1.
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    return {
      buffer: hasBom ? buf : Buffer.concat([Buffer.from(UTF8_BOM, 'utf-8'), buf]),
      contentType: 'text/csv; charset=utf-8',
      filename: exportFilename('behandlingshistorik', report.company.name, date, 'csv'),
    }
  }
  return {
    buffer: reportToWorkbook(specs),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: exportFilename('behandlingshistorik', report.company.name, date, 'xlsx'),
  }
}
