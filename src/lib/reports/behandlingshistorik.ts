import type { SupabaseClient } from '@supabase/supabase-js'
import { predicateDef } from '@/lib/arkiv/facts/predicates'
import type { AuditLogEntry } from '@/types'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { dbError } from '@/lib/errors/db-error'
import { fetchAppReleases, type AppReleaseRow } from '@/lib/reports/app-releases'
import { SOURCE_TYPE_LABELS_SV } from '@/lib/reports/systemdokumentation'
import { getPackage, packageForConfigKey } from '@/lib/modules/packages'
import { parseGrantPolicyVersion } from '@/lib/grants/types'
import { formatActorAttribution } from '@/lib/attribution/format-actor'
import {
  buildDecisionReceipts,
  fetchPeriodDecisions,
  type DecisionCandidate,
  type DecisionReceipt,
} from '@/lib/suggestion-log/receipts'
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
 * `bank_file_imports`, `collection_cases` and the company's decisions in
 * `collection_case_events`, and the decisions on bank lines, underlag and
 * approved staged operations in `suggestion_log`, read as decision receipts)
 * and turns them into one
 * chronological list of human-readable events. It never writes.
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
  type BehandlingshistorikVerifiedPrincipal,
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
  type BehandlingshistorikVerifiedPrincipal,
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
  import_batch_id?: string | null
  /**
   * The principal the database verified at commit (20261016110000). NULL on
   * verifikat posted before it; absent when the database predates it.
   */
  committed_auth_role?: string | null
  committed_auth_uid?: string | null
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
  /**
   * WHO relayed the rättelse beside the user (migration 20261016005000): the
   * committed_actor_type values. NULL or absent on rows written before it,
   * which read as the user, as they always have.
   */
  actor_type?: string | null
  actor_label?: string | null
  created_at: string
  /** 'sie_import' = correction history carried by the SIE file (#2427); absent/'user' = made here. */
  source?: 'user' | 'sie_import' | null
  sie_import_id?: string | null
  /** SIE `sign` on the #BTRANS/#RTRANS rows: who corrected in the source system. */
  external_signature?: string | null
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

/** A collection case (collection_cases): an invoice the company handed over to its collections provider. */
export interface CollectionCaseRow {
  id: string
  invoice_id: string
  submission_status: string
  opened_by: string | null
  opened_at: string
  closed_at: string | null
  close_reason: string | null
  provider_case_number: string | null
  /** The embedded invoice: one row at runtime (many-to-one), typed as either shape. */
  invoice: { invoice_number: string | null } | Array<{ invoice_number: string | null }> | null
}

/** A decision the company took on a collection case (collection_case_events, kind user_action). */
export interface CollectionCaseDecisionRow {
  id: string
  case_id: string
  occurred_at: string
  label: string
  actor_user_id: string | null
  raw: Record<string, unknown> | null
}

/** Event before user labels are resolved. */
interface RawActor {
  type: BehandlingshistorikActorType
  user_id: string | null
  actor_label: string | null
}

/** Verified principal before its user label is resolved. */
type RawVerifiedPrincipal = Omit<BehandlingshistorikVerifiedPrincipal, 'label'>

export interface RawBehandlingshistorikEvent extends Omit<BehandlingshistorikEvent, 'actor' | 'verified'> {
  actor: RawActor
  verified?: RawVerifiedPrincipal
}

// ============================================================
// Constants: tables, field labels, value labels
// ============================================================

/**
 * audit_log tables the report reads. Everything else (registers) is out of scope per BFN's commentary.
 * The rows are selected in SQL (behandlingshistorik_sources, together with
 * GLOBAL_ACTIONS); a unit test pins the function's lists to these constants.
 */
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
  'sie_import_chunks',
  'bank_file_imports',
  // Verifikationsserie per bankkonto (audited since migration 20260902124513):
  // the per-account override outranks the per-source-type map above, so it is
  // a behandlingsregel in the same sense.
  'cash_accounts',
  // Which bank account customer invoices pay to, per currency (migration
  // 20260904010000).
  'invoice_payee_defaults',
  // Which mailboxes the receipt hunt reads underlag from: connected and
  // disconnected, written by hand without tokens (extensions/general/mail).
  'mail_connections',
  // Reminders and debt collection through a provider (migration
  // 20261012030100): consent, activation, ending, and the rules applied when
  // invoices are handed over and collected payments and payouts are booked.
  'collection_connections',
  // Service accounts (migration 20261016120000): a non-human principal that
  // writes to the books through its own keys, created and revoked by an
  // owner or admin. Their keys are api_keys rows, logged above.
  'service_accounts',
  // A company's package choices (migration 20261016200400): which parts of
  // Accounted are switched on, by whom and why (an approved suggestion or the
  // company's own choice). Only the package keys render; the rows are written
  // by set_company_package_choice, which logs every change here.
  'company_capability_config',
  // Rules for automatic booking (grants, migration 20261017100200): which
  // counterparty an agent may book without a person, how, up to what amount,
  // who accepted it and when it was revoked; and the company's switch that
  // pauses them all. Written by create_company_grant, revoke_company_grant
  // and set_company_grants_paused, which log every change here.
  'company_grants',
  'company_grant_settings',
] as const

/**
 * Global (company-less) audit rows: statutory payroll constants. RLS hides
 * NULL-company rows from session clients, so these are fetched through the
 * service role when the caller provides one (`globalClient`).
 */
export const GLOBAL_AUDITED_TABLES = ['salary_payroll_config'] as const

/** Actions that matter regardless of table (security / integrity / retention / overridden guards). */
export const GLOBAL_ACTIONS = [
  'SECURITY_EVENT',
  'INTEGRITY_FAILURE',
  'RETENTION_BLOCK',
  'DOCUMENT_DELETE_BLOCKED',
  // A guard that warns before a booking was deliberately overridden. Selected
  // by action, not by table, because the tables such guards sit in front of
  // (supplier_invoices today) are registers that are otherwise out of scope.
  'GUARD_BYPASSED',
] as const

const COMMIT_METHOD_LABELS: Record<string, string> = {
  user_accept: 'Godkänd av användare',
  bulk_accept: 'Godkänd i massbokning',
  api_key: 'Via API-nyckel',
  agent_relay: 'Godkänd via assistenten',
  // An SIE import or provider migration (write_sie_job_entries, 20261015235000).
  migration: 'Importerad (SIE)',
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
  rot_rut_enabled: 'Påminnelse begäran ROT/RUT och grön teknik',
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
  salary_deviation_period: 'Avvikelseperiod för lön',
  salary_calculation_policy: 'Beräkningsprinciper för lön',
  salary_vacation_liability_method: 'Bokföring av semesterlöneskuld',
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
  entity_type: { aktiebolag: 'Aktiebolag', enskild_firma: 'Enskild firma', ideell_forening: 'Ideell förening' },
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
 * cash_accounts columns that are behandlingsregler. Each has a column-scoped
 * trigger (voucher_series 20260902124513, payee 20260904010000, enabled and
 * is_primary 20260921070500), and the read model must not resurrect
 * balance/name churn from bank sync if a row slips through.
 */
const CASH_ACCOUNT_FIELDS: Record<string, string> = {
  voucher_series: 'Verifikationsserie',
  // Migration 20260921070500. Both redirect an automatic account choice:
  // enabled decides the bank leg of a transaction with no bank account of its
  // own (resolveSettlementAccount), is_primary the skattekonto counter account.
  enabled: 'Aktivt',
  is_primary: 'Primärt bankkonto',
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

/**
 * The typed map shared with the systemdokumentation, so both documents name a
 * source the same way and a new source type cannot compile without a label.
 */
function sourceTypeLabel(sourceType: string | null | undefined): string {
  if (!sourceType) return 'Okänd'
  return (SOURCE_TYPE_LABELS_SV as Readonly<Record<string, string | undefined>>)[sourceType] ?? sourceType
}

function normaliseActorType(value: unknown): BehandlingshistorikActorType {
  switch (value) {
    case 'api_key':
    case 'mcp_oauth':
    case 'cron':
    case 'agent_chat':
    case 'system':
    case 'service_account':
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
    // An agent is named with the person it acted for, the row's user: the
    // key's owner, a service account's sponsor (who answers for it), who
    // chatted. "Claude åt anna@example.se", never the credential's name
    // (lib/attribution, in its Swedish words: this report stays Swedish).
    case 'api_key':
    case 'mcp_oauth':
    case 'agent_chat':
    case 'service_account':
      return formatActorAttribution({ actorType: actor.type, actorLabel: actor.actor_label, personName: userLabel ?? fallbackUser })
    case 'cron':
      return actor.actor_label ? `Schemalagd körning: ${actor.actor_label}` : 'Schemalagd körning'
    case 'system':
      return actor.actor_label ? `Systemet: ${actor.actor_label}` : 'Systemet'
    default:
      return userLabel ?? fallbackUser ?? 'Okänd användare'
  }
}

/**
 * Label for the principal the database verified at commit. The role is what
 * the request ran as (20261016110000): a signed-in user's JWT, the
 * application server's service key, or a direct database connection.
 */
export function formatVerifiedLabel(verified: RawVerifiedPrincipal, userLabels: Map<string, string>): string {
  switch (verified.role) {
    case 'authenticated': {
      if (!verified.user_id) return 'Inloggad användare (inget användar-id)'
      return `Inloggad användare: ${userLabels.get(verified.user_id) ?? `Användare ${verified.user_id.slice(0, 8)}`}`
    }
    case 'service_role':
      return 'Applikationsservern (service_role)'
    case 'anon':
      return 'Ej inloggad (anon)'
    default:
      return `Direkt databasanslutning (${verified.role})`
  }
}

/** The "Utförd av" cell of the exports: the actor, and the verified principal when the event has one. */
export function actorWithVerified(event: Pick<BehandlingshistorikEvent, 'actor' | 'verified'>): string {
  return event.verified
    ? `${event.actor.label} (verifierat av databasen: ${event.verified.label})`
    : event.actor.label
}

function finaliseEvent(
  raw: RawBehandlingshistorikEvent,
  userLabels: Map<string, string>,
): BehandlingshistorikEvent {
  const { verified, ...rest } = raw
  const event: BehandlingshistorikEvent = {
    ...rest,
    actor: {
      type: raw.actor.type,
      user_id: raw.actor.user_id,
      label: formatActorLabel(raw.actor, userLabels),
    },
  }
  if (verified) event.verified = { ...verified, label: formatVerifiedLabel(verified, userLabels) }
  return event
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
  if (entry.commit_method === 'migration' && entry.reverses_id) {
    // A storno posted by an SIE undo or a reviewed duplicate repair
    // (20261016005200): imported history taken back out, not imported.
    details.push('Bokföringssätt: Makulering av importerad verifikation (SIE)')
  } else if (entry.commit_method) {
    details.push(`Bokföringssätt: ${COMMIT_METHOD_LABELS[entry.commit_method] ?? entry.commit_method}`)
  }
  if (entry.reverses_id) details.push('Vändningsverifikation (storno)')
  if (entry.correction_of_id) details.push('Rättelseverifikation')
  const actorType = entry.committed_actor_type
    ? normaliseActorType(entry.committed_actor_type)
    : entry.commit_method === 'api_key'
      ? 'api_key'
      : 'user'
  const event: RawBehandlingshistorikEvent = {
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
  // The database's own stamp, next to the asserted actor. Verifikat posted
  // before 20261016110000 have none and read exactly as before.
  if (entry.committed_auth_role) {
    event.verified = { role: entry.committed_auth_role, user_id: entry.committed_auth_uid ?? null }
  }
  return event
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
  if (row.source === 'sie_import') {
    // History the source system recorded before the migration (SIE 4B
    // #BTRANS/#RTRANS). Not a rättelse made here: no actor, and the row's
    // created_at is the import moment, not when the correction happened
    // (SIE carries who, never when). Labelled apart so behandlingshistoriken
    // never claims a correction Accounted did not perform.
    const struck = Array.isArray(row.struck_lines) ? row.struck_lines : []
    const added = Array.isArray(row.added_lines) ? row.added_lines : []
    if (struck.length > 0) details.push(`Strukna rader i källsystemet (${struck.length}): ${struck.map(describeLine).join('; ')}`)
    if (added.length > 0) details.push(`Tillagda rader i källsystemet (${added.length}): ${added.map(describeLine).join('; ')}`)
    if (row.external_signature) details.push(`Signatur i källsystemet: ${row.external_signature}`)
    details.push('Tidpunkt = registrering vid SIE-import; rättelsedatum saknas i SIE-formatet')
    return {
      id: `rattelse:${row.id}`,
      occurred_at: toIso(row.created_at)!,
      category: 'verifikation',
      code: 'journal_entry.imported_correction_history',
      event: 'Rättelsehistorik från källsystemet (SIE-import)',
      object: entry ? voucherLabel(entry.voucher_series, entry.voucher_number) : null,
      actor: { type: 'system', user_id: null, actor_label: 'SIE-import' },
      details,
      source: 'rattelse_log',
      count: 1,
    }
  }
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
    // The API key, OAuth client, cron job or assistant that relayed it, when
    // the row records one; otherwise the user, as before.
    actor: {
      type: row.actor_type ? normaliseActorType(row.actor_type) : 'user',
      user_id: row.actor,
      actor_label: row.actor_label ?? null,
    },
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

/**
 * WHO reversed a verifikat. The trigger's REVERSE row carries the original's
 * user_id (who booked it, not who reversed it), and a reversal made over
 * PostgREST (reverseEntry, correctEntry) cannot hand the trigger an actor, so
 * its actor_type falls back to 'user'. The storno verifikat records who
 * reversed: its user_id is the reverser, and committed_actor_* names the
 * credential since the storno is posted through commit_journal_entry
 * (commitStornoOrCorrectionDraft). Without the storno in this report the row
 * speaks for itself, as before.
 */
function reversalActor(row: AuditLogEntry, ctx: NormaliseContext): RawActor {
  const stornoId = str(row.new_state?.reversed_by_id)
  const storno = stornoId ? ctx.entryById.get(stornoId) : undefined
  if (!storno?.user_id) return baseAuditActor(row)
  if (storno.committed_actor_type) {
    return {
      type: normaliseActorType(storno.committed_actor_type),
      user_id: storno.user_id,
      actor_label: storno.committed_actor_label,
    }
  }
  // An actor the row itself records (an SIE undo sets one) wins over an
  // unattributed storno; otherwise the storno's user is who reversed.
  if (row.actor_type && row.actor_type !== 'user') return baseAuditActor(row)
  return { type: 'user', user_id: storno.user_id, actor_label: null }
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
        actor: reversalActor(row, ctx),
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

/**
 * A service account's lifecycle (migration 20261016120000): created, then at
 * most once revoked; nothing else ever changes on the row. The actor is the
 * person (and credential) who created or revoked it; the sponsor answers for
 * every write the account makes and is named on those.
 */
function serviceAccountAuditEvent(row: AuditLogEntry): RawBehandlingshistorikEvent | null {
  const state = row.new_state ?? row.old_state
  const object = str(state?.name)
  switch (row.action) {
    case 'INSERT':
      return auditEvent(row, { category: 'atkomst', code: 'service_account.created', event: 'Tjänstekonto skapat', object })
    case 'UPDATE':
      if (!row.old_state?.revoked_at && row.new_state?.revoked_at) {
        return auditEvent(row, { category: 'atkomst', code: 'service_account.revoked', event: 'Tjänstekonto återkallat', object })
      }
      return null
    default:
      return null
  }
}

/**
 * A package switched on or off (set_company_package_choice, migration
 * 20261016200400): what changes how the system handles the company's work is
 * a dated processing-rule change (BFNAR 2013:2 p. 9.16). The approver is the
 * actor; the detail says whether an approved suggestion or the company itself
 * asked for it. A capability key row is entitlement state and renders nothing.
 */
function packageChoiceAuditEvent(row: AuditLogEntry): RawBehandlingshistorikEvent | null {
  if (row.action !== 'INSERT' && row.action !== 'UPDATE') return null
  const key = str(row.new_state?.capability_key)
  const dataChoice = key ? dataChoiceAuditEvent(row, key) : null
  if (dataChoice) return dataChoice
  const packageId = key ? packageForConfigKey(key) : null
  if (!packageId) return null
  const enabled = row.new_state?.enabled === true
  const source = str(row.new_state?.source)
  const details =
    source === 'suggestion' ? ['Källa: godkänt förslag'] : source === 'company' ? ['Källa: företagets eget val'] : []
  return auditEvent(row, {
    category: 'installningar',
    code: enabled ? 'package.switched_on' : 'package.switched_off',
    event: enabled ? 'Paket påslaget' : 'Paket avstängt',
    object: getPackage(packageId).nameSv,
    details,
  })
}

const DATA_CHOICE_OBJECTS: Record<string, string> = {
  ai: 'AI-bearbetning',
  'data:pooling': 'Anonyma mönster delas',
  'data:contribution': 'Innehåll till utvärdering och förbättring',
}

/**
 * A company data choice (set_company_data_choice, migration 20261021170000):
 * AI processing on or off changes how the system handles the bookkeeping, and
 * what the company lets us do with its data is its own instruction, so both
 * are dated lines next to the package switches. Only rows the company itself
 * wrote (source 'company') render: an `ai` row without a source is
 * entitlement state, as before.
 */
function dataChoiceAuditEvent(row: AuditLogEntry, key: string): RawBehandlingshistorikEvent | null {
  const object = DATA_CHOICE_OBJECTS[key]
  if (!object || str(row.new_state?.source) !== 'company') return null
  const enabled = row.new_state?.enabled === true
  return auditEvent(row, {
    category: 'installningar',
    code: enabled ? 'data_choice.switched_on' : 'data_choice.switched_off',
    event: enabled ? 'Inställning påslagen' : 'Inställning avstängd',
    object,
    details: ['Källa: företagets eget val'],
  })
}

/** Whole kronor with Swedish grouping, for a grant's limit. */
function fmtKronor(value: number): string {
  return value.toLocaleString('sv-SE', { maximumFractionDigits: 0 })
}

const GRANT_VAT_LABELS: Record<string, string> = {
  standard_25: 'moms 25 %',
  reduced_12: 'moms 12 %',
  reduced_6: 'moms 6 %',
  reverse_charge: 'omvänd betalningsskyldighet',
  exempt: 'ingen moms',
  export: 'export utan moms',
}

const GRANT_REVERSE_CHARGE_LABELS: Record<string, string> = {
  eu_services: 'tjänster från EU',
  non_eu_services: 'tjänster från länder utanför EU',
  domestic_services: 'inom Sverige, till exempel byggtjänster',
}

/** "konto 6212 moms 25 %": one invoice line's booking under a supplier-invoice rule ('6212:25'). */
function grantItemLineLabel(line: string): string {
  const [account, rate] = line.split(':')
  return rate === '0' ? `konto ${account} utan moms` : `konto ${account} moms ${rate} %`
}

/**
 * A rule for automatic booking (grant, migration 20261017100200): an
 * automatkontering in BFNAR 2013:2 p. 9.16's sense, dated when it is
 * accepted, superseded or revoked. The approver is the actor. One line says
 * what the rule permits: "Regel för automatisk bokföring: <motpart>, upp
 * till <belopp> kr", or for a known supplier's invoices from the inbox
 * (grants slice 2, migration 20261018100000) "Regel för automatisk
 * bokföring av leverantörsfakturor: <leverantör>, upp till <belopp> kr
 * inklusive moms", with the line bookings and the VAT treatment it pins.
 */
function grantAuditEvent(row: AuditLogEntry): RawBehandlingshistorikEvent | null {
  const state = (row.new_state ?? row.old_state ?? {}) as Record<string, unknown>
  const supplierInvoice = str(state.operation_type) === 'create_supplier_invoice_from_inbox'
  const counterparty =
    str(state.counterparty_label) ?? (supplierInvoice ? 'okänd leverantör' : (str(state.counterparty_key) ?? 'okänd motpart'))
  const limitRaw = state.amount_limit_sek
  const limit = typeof limitRaw === 'number' ? limitRaw : Number(limitRaw)
  const limitText = Number.isFinite(limit) ? `, upp till ${fmtKronor(limit)} kr${supplierInvoice ? ' inklusive moms' : ''}` : ''
  const version = typeof state.version === 'number' ? state.version : Number(state.version)
  const object = supplierInvoice
    ? `Regel för automatisk bokföring av leverantörsfakturor: ${counterparty}${limitText}`
    : `Regel för automatisk bokföring: ${counterparty}${limitText}`
  if (row.action === 'INSERT') {
    const details: string[] = []
    if (Number.isFinite(version)) details.push(`Version: ${version}`)
    const account = str(state.account_number)
    if (account) {
      const vat = str(state.vat_treatment)
      details.push(`Bokföring: konto ${account}${vat ? `, ${GRANT_VAT_LABELS[vat] ?? vat}` : ''}`)
    }
    if (supplierInvoice) {
      const supplierId = str(state.supplier_id)
      if (supplierId) details.push(`Leverantör: ${counterparty} (${supplierId})`)
      const lines = Array.isArray(state.item_lines) ? (state.item_lines as unknown[]).map(String) : []
      if (lines.length > 0) details.push(`Fakturarader: ${lines.map(grantItemLineLabel).join(', ')}`)
      const vat = str(state.vat_treatment)
      if (vat) {
        const kind = str(state.reverse_charge_kind)
        details.push(
          `Momsbehandling: ${GRANT_VAT_LABELS[vat] ?? vat}${kind ? ` (${GRANT_REVERSE_CHARGE_LABELS[kind] ?? kind})` : ''}`,
        )
      }
      details.push('Gäller: fakturor från inkorgen i SEK med underlag, som bokförs när de registreras')
    }
    const accounts = Array.isArray(state.line_accounts) ? (state.line_accounts as unknown[]).map(String) : []
    if (accounts.length > 0) details.push(`Konton i verifikatet: ${accounts.join(', ')}`)
    const monthlyRaw = state.monthly_limit_sek
    const monthly = monthlyRaw === null || monthlyRaw === undefined ? null : Number(monthlyRaw)
    if (monthly !== null && Number.isFinite(monthly)) details.push(`Högst per månad: ${fmtKronor(monthly)} kr`)
    const scope = str(state.credential_scope)
    details.push(
      scope === 'api_key'
        ? 'Gäller: en namngiven API-nyckel'
        : scope === 'service_account'
          ? 'Gäller: ett namngivet tjänstekonto'
          : 'Gäller: alla nycklar i företaget',
    )
    const validFrom = str(state.valid_from)
    if (validFrom) details.push(`Gäller från: ${validFrom.slice(0, 10)}`)
    return auditEvent(row, { category: 'installningar', code: 'grant.accepted', event: 'Regel för automatisk bokföring godkänd', object, details })
  }
  if (row.action === 'UPDATE' && !row.old_state?.revoked_at && row.new_state?.revoked_at) {
    const superseded = str(row.new_state?.revoked_reason) === 'superseded'
    return auditEvent(row, {
      category: 'installningar',
      code: superseded ? 'grant.superseded' : 'grant.revoked',
      event: superseded ? 'Regel för automatisk bokföring ersatt av ny version' : 'Regel för automatisk bokföring återkallad',
      object,
      details: Number.isFinite(version) ? [`Version: ${version}`] : [],
    })
  }
  return null
}

/** The company's switch that pauses every rule for automatic booking at once. */
function grantSettingsAuditEvent(row: AuditLogEntry): RawBehandlingshistorikEvent | null {
  if (row.action !== 'INSERT' && row.action !== 'UPDATE') return null
  const paused = row.new_state?.paused === true
  if (row.action === 'UPDATE' && (row.old_state?.paused === true) === paused) return null
  return auditEvent(row, {
    category: 'installningar',
    code: paused ? 'grants.paused' : 'grants.resumed',
    event: paused ? 'Automatisk bokföring enligt regler pausad' : 'Automatisk bokföring enligt regler återupptagen',
    object: 'Alla regler för automatisk bokföring',
  })
}

/**
 * A mailbox the receipt hunt reads underlag from: who connected it, with
 * which access, and when it was disconnected (and whether the provider
 * confirmed the access was withdrawn).
 */
function mailConnectionAuditEvent(row: AuditLogEntry): RawBehandlingshistorikEvent | null {
  const state = row.new_state ?? row.old_state
  const object = str(row.new_state?.email_address) ?? str(row.old_state?.email_address) ?? null
  switch (row.action) {
    case 'INSERT': {
      const scopes = state?.scopes
      const details = Array.isArray(scopes) && scopes.length > 0 ? [`Behörighet: ${fmtValue(scopes)}`] : []
      return auditEvent(row, { category: 'atkomst', code: 'mail_connection.connected', event: 'Brevlåda ansluten', object, details })
    }
    case 'DELETE': {
      const revocation = str(row.new_state?.provider_revocation)
      const details = revocation ? [`Återkallad hos leverantören: ${MAIL_REVOCATION_LABELS[revocation] ?? revocation}`] : []
      return auditEvent(row, { category: 'atkomst', code: 'mail_connection.disconnected', event: 'Brevlåda frånkopplad', object, details })
    }
    default:
      return null
  }
}

/**
 * collection_connections columns that are behandlingsregler: what is handed
 * over and how, and the accounts and automation used when collected
 * payments and payouts are booked. The status poll's columns (provider
 * status, health, run record) are not audited at all.
 */
const COLLECTION_CONNECTION_FIELDS: Record<string, string> = {
  minimum_amount: 'Lägsta belopp att skicka till inkasso',
  default_start_step: 'Första steget',
  reminder_fee_terms_since: 'Påminnelseavgift avtalad sedan',
  late_interest_percent: 'Avtalad dröjsmålsränta (procent)',
  late_interest_agreed_since: 'Dröjsmålsränta avtalad sedan',
  distribution_enabled: 'Utskick via inkassobolaget',
  ladder_mode: 'Förslag på påminnelser i Att göra',
  ladder_days_after_due: 'Dagar efter förfallodagen',
  clearing_account: 'Konto för inbetalningar via inkassobolaget',
  payout_account: 'Konto för utbetalningar från inkassobolaget',
  auto_book_collected_payments: 'Bokför inbetalningar via inkassobolaget automatiskt',
  auto_book_settlements: 'Bokför avräkningar automatiskt',
}

const COLLECTION_CONNECTION_VALUE_LABELS: Record<string, Record<string, string>> = {
  default_start_step: { reminder: 'Påminnelse', collection: 'Inkassokrav direkt' },
  ladder_mode: { off: 'Av', staged: 'Varje morgon, godkänns av en administratör' },
}

const COLLECTION_CONNECTION_STATE_EVENTS: Record<string, { code: string; event: string }> = {
  active: { code: 'collection_connection.activated', event: 'Påminnelser och inkasso aktiverat' },
  needs_setup: { code: 'collection_connection.needs_setup', event: 'Påminnelser och inkasso: inkassobolaget godkände inte eller stängde av kopplingen' },
  disconnected: { code: 'collection_connection.ended', event: 'Påminnelser och inkasso avslutat' },
  connecting: { code: 'collection_connection.connecting', event: 'Påminnelser och inkasso: aktivering pågår' },
}

function labelCollectionValues(state: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!state) return state
  const labelled: Record<string, unknown> = { ...state }
  for (const [key, labels] of Object.entries(COLLECTION_CONNECTION_VALUE_LABELS)) {
    const value = state[key]
    if (typeof value === 'string' && labels[value]) labelled[key] = labels[value]
  }
  return labelled
}

/**
 * The collections connection: the consent that started it, the provider's
 * terms accepted, activation and ending, and every change to its rules. A
 * change the status poll stored carries no person and shows as the system.
 */
function collectionConnectionAuditEvent(row: AuditLogEntry): RawBehandlingshistorikEvent | null {
  const state = row.new_state ?? row.old_state
  const object = str(state?.display_name)
  switch (row.action) {
    case 'INSERT': {
      const details = [`Villkor lästa och godkända i appen: version ${fmtValue(state?.catalogue_terms_version)}`]
      if (str(state?.dpa_version)) details.push(`Personuppgiftsvillkor: version ${fmtValue(state?.dpa_version)}`)
      return auditEvent(row, { category: 'atkomst', code: 'collection_connection.consented', event: 'Påminnelser och inkasso: aktivering påbörjad', object, details })
    }
    case 'DELETE':
      return auditEvent(row, { category: 'atkomst', code: 'collection_connection.deleted', event: 'Koppling för påminnelser och inkasso borttagen', object })
    case 'UPDATE': {
      const { lines } = diffFields(labelCollectionValues(row.old_state), labelCollectionValues(row.new_state), COLLECTION_CONNECTION_FIELDS)
      const before = str(row.old_state?.state)
      const after = str(row.new_state?.state)
      if (after && before !== after) {
        const meta = COLLECTION_CONNECTION_STATE_EVENTS[after]
        if (meta) return auditEvent(row, { category: 'atkomst', code: meta.code, event: meta.event, object, details: lines })
      }
      const terms = str(row.new_state?.terms_version)
      if (terms && terms !== str(row.old_state?.terms_version)) {
        return auditEvent(row, {
          category: 'atkomst',
          code: 'collection_connection.terms_accepted',
          event: 'Inkassobolagets villkor godkända',
          object,
          details: [`Version: ${terms}`, ...lines],
        })
      }
      if (lines.length === 0) return null
      return auditEvent(row, {
        category: 'installningar',
        code: 'collection_connection.updated',
        event: 'Regler för påminnelser och inkasso ändrade',
        object,
        details: lines,
      })
    }
    default:
      return null
  }
}

const MAIL_REVOCATION_LABELS: Record<string, string> = {
  revoked: 'ja',
  already_invalid: 'redan ogiltig',
  failed: 'ej bekräftat',
  shared: 'nej, brevlådan används av ett annat företag',
  no_token: 'nej, ingen behörighet sparad',
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

/**
 * Guards that warn before a booking and can be overridden. The key is
 * `new_state.guard` on a GUARD_BYPASSED row; an unknown guard renders nothing
 * rather than a half-labelled event.
 */
const GUARD_LABELS: Record<string, { code: string; event: string; check: string }> = {
  supplier_invoice_duplicate_payment: {
    code: 'supplier_invoice.duplicate_payment_guard_bypassed',
    event: 'Dubbelbetalningskontroll förbikopplad',
    check: 'möjlig dubbelbetalning av leverantörsfaktura',
  },
}

/** Why the detector flagged a bank row (DuplicatePaymentMatchReason). */
const DUPLICATE_MATCH_REASON_LABELS: Record<string, string> = {
  already_booked: 'redan bokförd som egen verifikation',
  ocr_exact: 'OCR eller referens stämmer',
  aggregate_exact: 'samlingsbetalning',
  name_amount_fuzzy: 'motpart och belopp stämmer',
  amount_only: 'endast beloppet stämmer',
}

/** One flagged bank row as a sentence fragment: date, amount, why, and the verifikat it already carries. */
function describeGuardCandidate(candidate: unknown, ctx: NormaliseContext): string {
  if (!candidate || typeof candidate !== 'object') return String(candidate)
  const c = candidate as Record<string, unknown>
  const amount = num(c.amount)
  // Absolute value: the direction is already in the event (a supplier payment
  // is outbound), and the sign adds nothing to a one-line summary.
  const head = [str(c.date) ?? '(okänt datum)', amount === null ? null : fmtAmount(Math.abs(amount))]
    .filter((part): part is string => !!part)
    .join(' ')
  const reason = str(c.match_reason)
  const why = reason ? (DUPLICATE_MATCH_REASON_LABELS[reason] ?? reason) : null
  const bookedOn = str(c.journal_entry_id)
  const entry = bookedOn ? ctx.entryById.get(bookedOn) : undefined
  const label = entry ? voucherLabel(entry.voucher_series, entry.voucher_number) : null
  const tail = [why, label ? `verifikation ${label}` : null].filter((part): part is string => !!part)
  return tail.length > 0 ? `${head} (${tail.join(', ')})` : head
}

/**
 * A guard the user overrode (audit_log GUARD_BYPASSED, migration
 * 20260914150102). The row is written by the bypass path itself, so the
 * statutory wording is built here from its structured `new_state` rather than
 * from the writer's own English description.
 */
function guardBypassedEvent(
  row: AuditLogEntry,
  ctx: NormaliseContext,
): RawBehandlingshistorikEvent | null {
  const state = (row.new_state ?? {}) as Record<string, unknown>
  const guard = str(state.guard)
  if (guard === ACCOUNTING_METHOD_MID_YEAR_GUARD) return accountingMethodCorrectionEvent(row, state)
  const meta = guard ? GUARD_LABELS[guard] : undefined
  if (!meta) return null

  const invoiceNumber = str(state.supplier_invoice_number)
  const entryId = str(state.journal_entry_id)
  const entry = entryId ? ctx.entryById.get(entryId) : undefined
  const object = entry
    ? voucherLabel(entry.voucher_series, entry.voucher_number)
    : invoiceNumber
      ? `Leverantörsfaktura ${invoiceNumber}`
      : null

  const details: string[] = [
    `Kontroll: ${meta.check}${invoiceNumber ? ` ${invoiceNumber}` : ''}`,
    'Orsak: användaren valde att bokföra ändå (force)',
  ]
  const amount = num(state.payment_amount)
  if (amount !== null) {
    const account = str(state.payment_account)
    details.push(
      `Betalning: ${fmtAmount(amount)} ${str(state.payment_currency) ?? 'SEK'}` +
        `, ${str(state.payment_date) ?? '(okänt datum)'}` +
        (account ? `, konto ${account}` : ''),
    )
  }
  const candidates = Array.isArray(state.candidates) ? state.candidates : []
  if (state.detector_failed === true) {
    details.push('Kontrollen kunde inte köras om vid bokföringstillfället.')
  } else if (candidates.length === 0) {
    details.push('Kontrollen hittade inga möjliga dubbletter vid bokföringstillfället.')
  } else {
    details.push(
      `Möjliga dubbletter vid bokföringstillfället (${candidates.length}): ` +
        candidates.map((candidate) => describeGuardCandidate(candidate, ctx)).join('; '),
    )
  }

  return auditEvent(row, {
    category: 'verifikation',
    code: meta.code,
    event: meta.event,
    object,
    details,
  })
}

/**
 * `new_state.guard` of an accounting method corrected in a fiscal year that
 * already had posted verifikat (lib/company/accounting-method-change.ts).
 */
const ACCOUNTING_METHOD_MID_YEAR_GUARD = 'accounting_method_mid_year'

/**
 * The mid-year guard on the accounting method, passed with a stated reason:
 * the change was recorded as a correction of a wrong setting. The trigger's
 * own company_settings row shows the same change as a plain settings diff;
 * this event carries why, and what the year already held.
 */
function accountingMethodCorrectionEvent(
  row: AuditLogEntry,
  state: Record<string, unknown>,
): RawBehandlingshistorikEvent {
  const details = [
    `Redovisningsmetod: ${fmtValue(state.from, 'accounting_method')} → ${fmtValue(state.to, 'accounting_method')}`,
    `Skäl: ${str(state.reason) ?? '(inget angivet)'}`,
  ]
  const posted = num(state.posted_entries)
  if (posted !== null) details.push(`Bokförda verifikationer i räkenskapsåret vid rättelsen: ${posted}`)
  const timed = num(state.method_timed_entries)
  if (timed) details.push(`Varav bokförda av fakturaflödet enligt tidigare metod: ${timed} (oförändrade)`)
  return auditEvent(row, {
    category: 'installningar',
    code: 'settings.accounting_method_corrected',
    event: 'Redovisningsmetod rättad under räkenskapsåret',
    object: str(state.fiscal_year),
    details,
  })
}

/** One audit_log row → zero or one behandlingshistorik event. Exported for tests. */
export function auditRowToEvent(
  row: AuditLogEntry,
  ctx: NormaliseContext = { rattelseMetadataAt: new Map(), entryById: new Map() },
): RawBehandlingshistorikEvent | null {
  // Ahead of the generic global branch: a bypassed guard is a verifikat event
  // with its own wording, not an untyped "Säkerhetshändelse".
  if (row.action === 'GUARD_BYPASSED') return guardBypassedEvent(row, ctx)
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
    case 'service_accounts':
      return serviceAccountAuditEvent(row)
    case 'company_capability_config':
      return packageChoiceAuditEvent(row)
    case 'company_grants':
      return grantAuditEvent(row)
    case 'company_grant_settings':
      return grantSettingsAuditEvent(row)
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
      // A user removing an unbooked account (remove_cash_account,
      // 20260927212000): the account is old_state, what went with it
      // new_state. Removing one moves the bank leg resolveSettlementAccount
      // picks, like turning it off does.
      if (row.action === 'DELETE' && row.new_state?.deleted_transactions !== undefined) {
        return auditEvent(row, {
          category: 'installningar',
          code: 'cash_account.deleted',
          event: 'Bankkonto borttaget',
          object: [str(row.old_state?.name), str(row.old_state?.ledger_account)].filter(Boolean).join(' ') || null,
          details: [`Obokförda transaktioner borttagna: ${fmtValue(row.new_state.deleted_transactions)}`],
        })
      }
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
    case 'mail_connections':
      return mailConnectionAuditEvent(row)
    case 'collection_connections':
      return collectionConnectionAuditEvent(row)
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
    case 'sie_import_chunks': {
      if (row.action !== 'COMMIT') return null
      const state = row.new_state
      const entries = Array.isArray(state?.entries) ? state.entries as Array<Record<string, unknown>> : []
      return auditEvent(row, {
        category: 'import',
        code: 'sie_import.chunk_committed',
        event: 'SIE-importdel bokförd',
        object: str(state?.import_id),
        details: [
          `Del: ${fmtValue(state?.phase)} ${fmtValue(state?.chunk_no)}`,
          `Kontrollsumma: ${fmtValue(state?.payload_hash)}`,
          ...entries.map(entry => `${voucherLabel(entry.series, entry.voucherNumber)}: ${fmtValue(entry.id)}`),
        ],
      })
    }
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

// ============================================================
// Collection cases (handover of a kundfordran to the company's provider)
// ============================================================
//
// Handing an invoice over changes how its kundfordran is processed from
// then on: Accounted's own reminders and reminder fees stop for it, and the
// provider pursues the customer until the case closes. Neither the handover
// nor a decision on the case is a bokföringspost, so they are listed under
// Övrigt with who decided and when; the provider's own steps stay on the
// invoice's case card.

const COLLECTION_ACTION_LABELS: Record<string, string> = {
  start: 'påminnelser startade',
  approve_step: 'nästa steg godkänt',
  pause: 'ärendet pausat',
  resume: 'ärendet återupptaget',
  withdraw: 'ärendet återkallat',
  dispute: 'markerat som bestritt',
  contest_dispute: 'drivs vidare trots bestridandet',
  already_paid: 'bekräftat som betalt',
  confirm_not_paid: 'besvarat: fakturan är inte betald',
  approve_legal_action: 'godkänt att ärendet går till Kronofogden',
  decline_legal_action: 'avstod från Kronofogden',
}

const COLLECTION_CLOSE_REASON_LABELS: Record<string, string> = {
  paid: 'betald',
  withdrawn: 'återkallad',
  credited: 'krediterad',
  insolvent: 'kunden saknar betalningsförmåga',
  bankrupt: 'kunden har gått i konkurs',
  deceased: 'kunden har avlidit',
  moved_abroad: 'kunden har flyttat utomlands',
  error: 'ett fel',
  other: 'annan orsak',
}

/** Cases that reached the provider: a refused or never-sent handover changed nothing. */
function caseWasHandedOver(row: CollectionCaseRow): boolean {
  return row.submission_status === 'submitted' || row.submission_status === 'registered'
}

function collectionCaseObject(row: CollectionCaseRow | undefined): string | null {
  const invoice = Array.isArray(row?.invoice) ? row.invoice[0] : row?.invoice
  const number = invoice?.invoice_number
  return number ? `Faktura ${number}` : 'Faktura'
}

/** The handover and, once the provider closed it, the close of one case. */
export function collectionCaseEvents(row: CollectionCaseRow): RawBehandlingshistorikEvent[] {
  if (!caseWasHandedOver(row)) return []
  const object = collectionCaseObject(row)
  const events: RawBehandlingshistorikEvent[] = [
    {
      id: `collection:${row.id}:opened`,
      occurred_at: toIso(row.opened_at)!,
      category: 'ovrigt',
      code: 'collection_case.handed_over',
      event: 'Faktura lämnad till inkasso',
      object,
      actor: { type: 'user', user_id: row.opened_by, actor_label: null },
      details: [
        ...(row.provider_case_number ? [`Ärendenummer: ${row.provider_case_number}`] : []),
        'Accounted skickar inga egna påminnelser för fakturan medan ärendet är öppet',
      ],
      source: 'collection_case',
      count: 1,
    },
  ]
  if (row.closed_at) {
    const reason = row.close_reason ? COLLECTION_CLOSE_REASON_LABELS[row.close_reason] ?? row.close_reason : null
    events.push({
      id: `collection:${row.id}:closed`,
      occurred_at: toIso(row.closed_at)!,
      category: 'ovrigt',
      code: 'collection_case.closed',
      event: 'Inkassoärende avslutat',
      object,
      actor: { type: 'system', user_id: null, actor_label: 'inkassobolaget' },
      details: reason ? [`Orsak: ${reason}`] : [],
      source: 'collection_case',
      count: 1,
    })
  }
  return events
}

/** A decision the company took on a case: who decided, and through which door. */
export function collectionDecisionEvent(
  row: CollectionCaseDecisionRow,
  caseRow: CollectionCaseRow | undefined,
): RawBehandlingshistorikEvent {
  const raw = row.raw ?? {}
  const action = str(raw.action) ?? row.label
  const details: string[] = []
  const until = str(raw.until)
  if (until) details.push(`Till och med ${until}`)
  if (str(raw.bank_checked_at)) {
    details.push(raw.bank_attested === true ? 'Banken kontrollerad; användaren intygade att fakturan inte är betald' : 'Banken kontrollerad: ingen obokförd inbetalning')
  }
  if (Array.isArray(raw.dismissed_transaction_ids) && raw.dismissed_transaction_ids.length > 0) {
    details.push(`${raw.dismissed_transaction_ids.length} banktransaktioner bedömda som inte betalning av fakturan`)
  }
  if (raw.withdraw_fee_acknowledged === true) details.push('Användaren godkände att återkallelsen kan kosta en avgift')
  if (raw.channel === 'agent') details.push('Föreslaget av en agent eller API-nyckel')
  return {
    id: `collection-decision:${row.id}`,
    occurred_at: toIso(row.occurred_at)!,
    category: 'ovrigt',
    code: 'collection_case.decision',
    event: `Inkassoärende: ${COLLECTION_ACTION_LABELS[action] ?? action}`,
    object: collectionCaseObject(caseRow),
    actor: { type: 'user', user_id: row.actor_user_id, actor_label: null },
    details,
    source: 'collection_case',
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

// ============================================================
// Beslut och förslag: decisions on bank lines, underlag and approved
// staged operations (agentförslag)
// ============================================================

const DECISION_SOURCE_LABELS: Record<DecisionCandidate['source'], string> = {
  assistant: 'assistenten',
  rule: 'regel',
  catalog: 'mall',
  counterparty_template: 'motpartsmall',
  recent: 'tidigare bokning',
  extraction: 'dokumentläsning',
  pending_operation: 'agentförslag',
}

const DECISION_OUTCOME_LABELS: Record<Exclude<DecisionReceipt['outcome'], 'dismissed'>, string> = {
  accepted: 'Förslag följt',
  changed: 'Förslag ändrat före bokföring',
  manual: 'Bokfört utan förslag',
}

const INBOX_FIELD_LABELS: Record<string, string> = {
  supplier_name: 'leverantör',
  supplier_org_number: 'organisationsnummer',
  invoice_number: 'fakturanummer',
  invoice_date: 'fakturadatum',
  due_date: 'förfallodatum',
  payment_reference: 'betalningsreferens',
  currency: 'valuta',
  total: 'belopp',
  vat_amount: 'moms',
  accounts: 'konton',
}

/** The guards a booking door records (lib/suggestion-log/checks.ts), as the report names them. */
const DECISION_CHECK_LABELS: Record<string, string> = {
  already_booked: 'inte redan bokförd',
  duplicate: 'dubblettkontroll',
  currency: 'valuta',
  reverse_charge_seller_vat: 'säljarens moms vid omvänd skattskyldighet',
  counter_legs: 'motkonto',
  bank_line_direction: 'bankradens sida',
  chart: 'kontoplan',
  dimension_policy: 'dimensionskrav',
  invoice_match: 'öppen faktura',
  period_lock: 'periodlås',
  document_reuse: 'underlaget inte redan använt',
  payee_alert: 'betalningsmottagare',
  representation_vat_cap: 'representationsmoms',
}

const DECISION_BAND_LABELS: Record<NonNullable<DecisionReceipt['confidence_band']>, string> = {
  direct: 'kunde bokföras direkt',
  review: 'krävde granskning',
}

/** Rules, policy and guards the decision was made under, as recorded then. */
function decisionProvenanceDetails(r: DecisionReceipt): string[] {
  const details: string[] = []
  if (r.rule_version) details.push(`Regelversion: ${r.rule_version}`)
  if (r.policy_version) {
    const band = r.confidence_band ? `, bedömning: ${DECISION_BAND_LABELS[r.confidence_band]}` : ''
    details.push(`Policy: ${r.policy_version}${band}`)
  }
  if (r.checks) {
    details.push(`Kontroller: ${r.checks.length}`)
    for (const c of r.checks) {
      if (c.result === 'pass') continue
      const label = DECISION_CHECK_LABELS[c.id] ?? c.id
      details.push(`Kontroll ${c.result === 'warn' ? 'med varning' : 'underkänd'}: ${label}${c.detail ? ` (${c.detail})` : ''}`)
    }
  }
  return details
}

const DECISION_SUBJECT_LABELS: Record<DecisionReceipt['subject_kind'], { one: string; many: string }> = {
  bank_line: { one: 'banktransaktion', many: 'banktransaktioner' },
  inbox_item: { one: 'underlag', many: 'underlag' },
  operation: { one: 'agentförslag', many: 'agentförslag' },
}

function decisionSubject(kind: DecisionReceipt['subject_kind']): string {
  return DECISION_SUBJECT_LABELS[kind].one
}

/** The subject standing in for a voucher number the report does not know. */
function decisionObject(kind: DecisionReceipt['subject_kind']): string {
  const one = decisionSubject(kind)
  return one.charAt(0).toUpperCase() + one.slice(1)
}

function decisionEventLabel(r: DecisionReceipt): string {
  if (r.outcome === 'dismissed') return r.subject_kind === 'bank_line' ? 'Banktransaktion ignorerad' : 'Underlag raderat'
  // An approval books exactly what was staged: no suggestion to follow or change.
  if (r.subject_kind === 'operation') {
    return parseGrantPolicyVersion(r.policy_version) ? 'Bokfört automatiskt enligt regel' : 'Agentförslag godkänt'
  }
  return DECISION_OUTCOME_LABELS[r.outcome]
}

function percent(value: number): string {
  return `${Math.round(value * 100)} %`
}

/**
 * What was on offer, what was taken and on what basis, what was booked, and
 * who proposed it: the agent and the person it staged the proposal for,
 * named from `userLabels` (the generator resolves them before it builds the
 * decisions).
 */
export function decisionDetails(r: DecisionReceipt, userLabels: Map<string, string> = new Map()): string[] {
  const details: string[] = []
  if (r.booked?.voucher) details.push(`Gäller: ${decisionSubject(r.subject_kind)}`)
  if (r.candidates.length === 0) {
    details.push('Inga förslag fanns')
  } else {
    const sources = [...new Set(r.candidates.map((c) => DECISION_SOURCE_LABELS[c.source]))]
    details.push(`Förslag: ${r.candidates.length} (${sources.join(', ')})`)
  }
  if (r.chosen) {
    const accounts = r.chosen.accounts.length > 0 ? `, konto ${r.chosen.accounts.join(', ')}` : ''
    details.push(`Valt förslag: ${DECISION_SOURCE_LABELS[r.chosen.source]}${accounts}`)
  }
  if (r.confidence.value != null) {
    details.push(
      r.confidence.basis === 'model_reported'
        ? `Modellens egen säkerhet: ${percent(r.confidence.value)}`
        : `Säkerhet: ${percent(r.confidence.value)}`,
    )
  }
  if (r.chosen?.model) details.push(`Modell: ${r.chosen.model}`)
  if (r.booked?.account) details.push(`Bokfört konto: ${r.booked.account}`)
  if (r.booked && r.booked.changed_fields.length > 0) {
    details.push(`Ändrade fält: ${r.booked.changed_fields.map((f) => INBOX_FIELD_LABELS[f] ?? f).join(', ')}`)
  }
  if (r.proposed_by && r.proposed_by.actor_type !== 'user') {
    const proposer = formatActorLabel(
      { type: normaliseActorType(r.proposed_by.actor_type), user_id: r.proposed_by.user_id ?? null, actor_label: r.proposed_by.label },
      userLabels,
    )
    details.push(`Föreslaget av: ${proposer}`)
  }
  // The agent's own words, as the approver saw them.
  if (r.agent_reason) details.push(`Agentens motivering: ${r.agent_reason}`)
  const grant = r.subject_kind === 'operation' ? parseGrantPolicyVersion(r.policy_version) : null
  if (grant) {
    details.push(`Bokfört utan godkännande av en person, enligt regel ${grant.grantId} version ${grant.grantVersion}`)
  }
  details.push(...decisionProvenanceDetails(r))
  return details
}

function decisionEvent(r: DecisionReceipt, userLabels: Map<string, string>): RawBehandlingshistorikEvent {
  return {
    id: `decision:${r.receipt_id}`,
    occurred_at: toIso(r.decided_at) ?? r.decided_at,
    category: 'beslut',
    code: `decision.${r.outcome}`,
    event: decisionEventLabel(r),
    object: r.booked?.voucher ?? decisionObject(r.subject_kind),
    actor: { type: r.decided_by.actor_type, user_id: r.decided_by.user_id, actor_label: r.decided_by.label },
    details: decisionDetails(r, userLabels),
    source: 'suggestion_log',
    count: 1,
  }
}

/**
 * One event per decision. A samlingsverifikat books many bank lines in one
 * decision, written as one insert (one timestamp), so the receipts that
 * booked the same voucher at the same moment become one event carrying
 * their count, the way bursts of identical changes are collapsed. Decisions
 * on one voucher at different moments stay separate events.
 */
export function decisionEvents(receipts: DecisionReceipt[], userLabels: Map<string, string> = new Map()): RawBehandlingshistorikEvent[] {
  const byVoucher = new Map<string, DecisionReceipt[]>()
  const events: RawBehandlingshistorikEvent[] = []
  for (const r of receipts) {
    const entryId = r.booked?.journal_entry_id
    if (!entryId) {
      events.push(decisionEvent(r, userLabels))
      continue
    }
    const key = `${entryId}|${r.decided_at}`
    const group = byVoucher.get(key) ?? []
    group.push(r)
    byVoucher.set(key, group)
  }
  for (const group of byVoucher.values()) {
    if (group.length === 1) {
      events.push(decisionEvent(group[0], userLabels))
      continue
    }
    const sorted = [...group].sort((a, b) => a.decided_at.localeCompare(b.decided_at) || a.receipt_id.localeCompare(b.receipt_id))
    const first = sorted[0]
    const counts = new Map<string, number>()
    for (const r of sorted) counts.set(decisionEventLabel(r), (counts.get(decisionEventLabel(r)) ?? 0) + 1)
    const proposer = first.proposed_by && first.proposed_by.actor_type !== 'user'
      ? decisionDetails(first, userLabels).find((d) => d.startsWith('Föreslaget av: '))
      : undefined
    events.push({
      id: `decision:${first.receipt_id}:batch`,
      occurred_at: toIso(first.decided_at) ?? first.decided_at,
      category: 'beslut',
      code: 'decision.batch',
      event: 'Samlingsbeslut',
      object: first.booked?.voucher ?? null,
      actor: { type: first.decided_by.actor_type, user_id: first.decided_by.user_id, actor_label: first.decided_by.label },
      details: [
        `${sorted.length} ${DECISION_SUBJECT_LABELS[first.subject_kind].many} i en verifikation`,
        ...[...counts.entries()].map(([label, n]) => `${label}: ${n}`),
        ...(proposer ? [proposer] : []),
        // One approval, one staged operation: the rows share its reason.
        ...(first.agent_reason ? [`Agentens motivering: ${first.agent_reason}`] : []),
        // One insert, one snapshot: the rows share their rules version.
        ...(first.rule_version ? [`Regelversion: ${first.rule_version}`] : []),
      ],
      source: 'suggestion_log',
      count: sorted.length,
    })
  }
  return events
}

/** Operation ids per sponsor read: 100 ids stay well under the gateway's 8 KB request line. */
const SPONSOR_ID_CHUNK = 100

/**
 * The person each agent proposal was staged for (pending_operations.user_id:
 * the key's owner, a service account's sponsor, who chatted), which
 * behandlingshistorik_decisions does not return. Read by operation id, for
 * agent proposals only. Best-effort: a failed read leaves the proposal named
 * by its agent alone, never fails the report.
 */
async function withProposalSponsors(
  supabase: SupabaseClient,
  companyId: string,
  receipts: DecisionReceipt[],
): Promise<DecisionReceipt[]> {
  const ids = [
    ...new Set(
      receipts
        .map((r) => r.proposed_by)
        .filter((p): p is NonNullable<DecisionReceipt['proposed_by']> => !!p && p.actor_type !== 'user' && !p.user_id)
        .map((p) => p.pending_operation_id),
    ),
  ]
  if (ids.length === 0) return receipts
  const sponsors = new Map<string, string>()
  const reads = await Promise.all(
    chunk(ids, SPONSOR_ID_CHUNK).map((part) =>
      supabase.from('pending_operations').select('id, user_id').eq('company_id', companyId).in('id', part),
    ),
  )
  for (const { data, error } of reads) {
    if (error) continue
    for (const row of (data ?? []) as { id: string; user_id: string | null }[]) {
      if (row.user_id) sponsors.set(row.id, row.user_id)
    }
  }
  return receipts.map((r) => {
    const sponsor = r.proposed_by ? sponsors.get(r.proposed_by.pending_operation_id) : undefined
    return sponsor && r.proposed_by ? { ...r, proposed_by: { ...r.proposed_by, user_id: sponsor } } : r
  })
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
  collection_case: 6,
  suggestion_log: 7,
}

/** `a.localeCompare(b)` is defined as this collator's compare; one instance instead of one lookup per call. */
const ID_COLLATOR = new Intl.Collator()

/**
 * Chronological, then by source, then by id. The keys are read once per
 * event: a year is 100 000+ events, and parsing both timestamps inside the
 * comparator cost two Date.parse calls per comparison.
 */
export function sortEvents<T extends { occurred_at: string; source: BehandlingshistorikSource; id: string }>(
  events: T[],
): T[] {
  const keyed = events.map((event) => ({ event, t: toMs(event.occurred_at), s: SOURCE_ORDER[event.source] }))
  keyed.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t
    if (a.s !== b.s) return a.s - b.s
    return ID_COLLATOR.compare(a.event.id, b.event.id)
  })
  return keyed.map((k) => k.event)
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

/** The period's ledger history, as the report reads it. */
interface LedgerHistoryRows {
  entries: EntryRow[]
  audit: AuditLogEntry[]
  rattelse: RattelseRow[]
}

/** The row behandlingshistorik_sources() returns: audit rows inside and outside the window apart. */
interface LedgerHistoryRow extends LedgerHistoryRows {
  audit_outside: AuditLogEntry[]
}

/**
 * The verifikat, audit rows and rättelser of one report, in one statement
 * (behandlingshistorik_sources, migration 20261023094050). It joins the
 * period's verifikat in SQL: they were sent back as .in() lists of 200 ids,
 * four times over, and the decisions list crossed the gateway's 8 KB request
 * line. Fiscal-year mode returns every verifikat of the period and the
 * record-id unions; date-range mode the verifikat committed in the window and
 * the ones the window's rows look up by id, which is all entryById is read for.
 * Rows no event can come from stay in the database (see the migration).
 */
async function fetchLedgerHistory(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  window: { fromTs: string; toTs: string },
  fiscalYear: boolean,
): Promise<LedgerHistoryRows> {
  const { data, error } = await supabase.rpc('behandlingshistorik_sources', {
    p_company_id: companyId,
    p_period_id: periodId,
    p_from: window.fromTs,
    p_to: window.toTs,
    p_fiscal_year: fiscalYear,
  })
  if (error) throw dbError(error, null)
  // One row of JSON arrays (a scalar json result would be parsed again by PostgREST).
  const row = ((data as Partial<LedgerHistoryRow>[] | null) ?? [])[0] ?? {}
  return {
    entries: row.entries ?? [],
    // Disjoint by created_at: the window's rows, then those about the period's
    // verifikat logged outside it (fiscal-year mode).
    audit: [...(row.audit ?? []), ...(row.audit_outside ?? [])],
    rattelse: row.rattelse ?? [],
  }
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

async function fetchCollectionCases(supabase: SupabaseClient, companyId: string): Promise<CollectionCaseRow[]> {
  return fetchAllRows<CollectionCaseRow>(({ from, to }) =>
    supabase
      .from('collection_cases')
      .select('id, invoice_id, submission_status, opened_by, opened_at, closed_at, close_reason, provider_case_number, invoice:invoices(invoice_number)')
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to),
  )
}

async function fetchCollectionDecisions(
  supabase: SupabaseClient,
  companyId: string,
  window: { fromTs: string; toTs: string },
): Promise<CollectionCaseDecisionRow[]> {
  return fetchAllRows<CollectionCaseDecisionRow>(({ from, to }) =>
    supabase
      .from('collection_case_events')
      .select('id, case_id, occurred_at, label, actor_user_id, raw')
      .eq('company_id', companyId)
      .eq('kind', 'user_action')
      .gte('occurred_at', window.fromTs)
      .lte('occurred_at', window.toTs)
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

/**
 * Arkiv (BFL 5 kap 11 §, BFNAR 2013:2 p. 9.16): the facts the archive holds
 * about the company, with every supersession and deprecation, and the moment
 * each extraction schema version and each software version was first used
 * for this company. Read from company_facts and activities directly: both
 * are append-only with their own timestamps, so no audit row is needed.
 */
export interface CompanyFactRow {
  id: string
  predicate: string
  value_text: string
  subject_kind: string
  sys_from: string
  sys_to: string | null
  rank: string
  deprecation_reason: string | null
  supersedes_id: string | null
  source_kind: string
  source_document_id: string | null
  approved_by_user_id: string | null
  rationale: string | null
}

export interface ArkivActivityRow {
  id: string
  kind: string
  schema_type: string | null
  schema_version: number | null
  model_ids: string[] | null
  started_at: string
  agents: { name: string; version: string | null } | Array<{ name: string; version: string | null }> | null
}

const ARKIV_ACTOR: RawActor = { type: 'system', user_id: null, actor_label: 'Arkiv' }

const FACT_SOURCE_LABELS: Record<string, string> = {
  extraction: 'läst ur dokument',
  ledger: 'härlett ur bokföringen',
  registry: 'från register',
  person: 'angivet av person',
  agent: 'föreslaget av agent, godkänt av person',
}

export function companyFactEvents(row: CompanyFactRow, labels: (predicate: string) => string): RawBehandlingshistorikEvent[] {
  const object = `${labels(row.predicate)}: ${row.value_text}`
  const actor: RawActor = row.approved_by_user_id ? { type: 'user', user_id: row.approved_by_user_id, actor_label: null } : ARKIV_ACTOR
  const events: RawBehandlingshistorikEvent[] = [
    {
      id: `fact:${row.id}`,
      occurred_at: toIso(row.sys_from)!,
      category: 'arkiv',
      code: row.supersedes_id ? 'fact.superseded' : 'fact.recorded',
      event: row.supersedes_id ? 'Faktum ersatt' : 'Faktum fastställt',
      object,
      actor,
      details: [FACT_SOURCE_LABELS[row.source_kind] ?? row.source_kind, ...(row.rationale ? [row.rationale] : [])],
      source: 'audit_log',
      count: 1,
    },
  ]
  if (row.rank === 'deprecated' && row.sys_to) {
    events.push({
      id: `fact:${row.id}:deprecated`,
      occurred_at: toIso(row.sys_to)!,
      category: 'arkiv',
      code: 'fact.deprecated',
      event: 'Faktum avfärdat',
      object,
      actor: ARKIV_ACTOR,
      details: row.deprecation_reason ? [row.deprecation_reason] : [],
      source: 'audit_log',
      count: 1,
    })
  }
  return events
}

/** One event per schema version and per software version, dated the first time this company's documents met it. */
export function arkivActivityEvents(rows: ArkivActivityRow[]): RawBehandlingshistorikEvent[] {
  const firstBy = new Map<string, { at: string; event: string; object: string; details: string[]; id: string }>()
  for (const row of [...rows].sort((a, b) => a.started_at.localeCompare(b.started_at))) {
    if (row.schema_type && row.schema_version != null) {
      const key = `schema:${row.schema_type}:${row.schema_version}`
      if (!firstBy.has(key)) {
        firstBy.set(key, { at: row.started_at, id: `arkiv:${row.id}:schema`, event: 'Extraktionsschema togs i bruk', object: `${row.schema_type} version ${row.schema_version}`, details: row.model_ids?.length ? [`Modeller: ${row.model_ids.join(', ')}`] : [] })
      }
    }
    const agent = Array.isArray(row.agents) ? row.agents[0] : row.agents
    if (agent?.name && agent.version) {
      const key = `agent:${agent.name}:${agent.version}`
      if (!firstBy.has(key)) {
        firstBy.set(key, { at: row.started_at, id: `arkiv:${row.id}:agent`, event: 'Programvaruversion togs i bruk i Arkiv', object: `${agent.name} version ${agent.version}`, details: [] })
      }
    }
  }
  return [...firstBy.values()].map((e) => ({
    id: e.id,
    occurred_at: toIso(e.at)!,
    category: 'arkiv',
    code: e.id.endsWith(':schema') ? 'arkiv.schema_in_use' : 'arkiv.agent_in_use',
    event: e.event,
    object: e.object,
    actor: ARKIV_ACTOR,
    details: e.details,
    source: 'audit_log',
    count: 1,
  }))
}

async function fetchCompanyFacts(supabase: SupabaseClient, companyId: string, window: { fromTs: string; toTs: string }): Promise<CompanyFactRow[]> {
  return fetchAllRows<CompanyFactRow>(({ from, to }) =>
    supabase
      .from('company_facts')
      .select('id, predicate, value_text, subject_kind, sys_from, sys_to, rank, deprecation_reason, supersedes_id, source_kind, source_document_id, approved_by_user_id, rationale')
      .eq('company_id', companyId)
      .lte('sys_from', window.toTs)
      .or(`sys_to.is.null,sys_to.gte.${window.fromTs}`)
      .order('sys_from', { ascending: true })
      .range(from, to),
  )
}

async function fetchArkivActivities(supabase: SupabaseClient, companyId: string): Promise<ArkivActivityRow[]> {
  return fetchAllRows<ArkivActivityRow>(({ from, to }) =>
    supabase
      .from('activities')
      .select('id, kind, schema_type, schema_version, model_ids, started_at, agents(name, version)')
      .eq('company_id', companyId)
      .eq('kind', 'extract')
      .order('started_at', { ascending: true })
      .range(from, to),
  )
}

export async function generateBehandlingshistorik(
  supabase: SupabaseClient,
  companyId: string,
  params: BehandlingshistorikParams,
  options: GenerateBehandlingshistorikOptions = {},
): Promise<BehandlingshistorikReport | null> {
  const period = await fetchPeriod(supabase, companyId, params.periodId)
  if (!period) return null

  const mode: BehandlingshistorikReport['mode'] = params.fromDate || params.toDate ? 'date_range' : 'fiscal_year'
  const from = params.fromDate ?? period.period_start
  const to = params.toDate ?? period.period_end
  const fromTs = `${from}T00:00:00.000Z`
  const toTs = `${to}T23:59:59.999Z`
  const fromMs = Date.parse(fromTs)
  const toMsBound = Date.parse(toTs)
  const window = { fromTs, toTs }
  const fiscalYear = mode === 'fiscal_year'

  const [company, ledger, decisions, resets, sieImports, bankImports, releases, globalAuditRows, companyFacts, arkivActivities, collectionCases, collectionDecisions] = await Promise.all([
    fetchCompany(supabase, companyId),
    fetchLedgerHistory(supabase, companyId, period.id, window, fiscalYear),
    // Decisions on bank lines and underlag: those registered in the window,
    // plus in fiscal-year mode every one that booked one of the year's
    // vouchers, the same record-id union the audit rows get.
    fetchPeriodDecisions(supabase, companyId, { periodId: period.id, window, fiscalYear }),
    fetchMigrationResets(supabase, companyId),
    fetchSieImports(supabase, companyId),
    fetchBankFileImports(supabase, companyId),
    fetchAppReleases(supabase, window),
    options.globalClient ? fetchGlobalAuditRows(options.globalClient, window) : Promise.resolve([] as AuditLogEntry[]),
    fetchCompanyFacts(supabase, companyId, window),
    fetchArkivActivities(supabase, companyId),
    fetchCollectionCases(supabase, companyId),
    fetchCollectionDecisions(supabase, companyId, window),
  ])
  const { entries, audit: auditRows, rattelse: rattelseRows } = ledger
  const entryById = new Map(entries.map((e) => [e.id, e]))

  const raw: RawBehandlingshistorikEvent[] = []

  // System-wide changes (p. 9.16 second paragraph): program versions and the
  // statutory payroll constants, dated by when they entered production.
  raw.push(...appReleaseEvents(releases))
  // Arkiv: the record's facts and the schema and software versions that read
  // them, inside the window (p. 9.16: schema, model and prompt changes).
  const inWindow = (ev: RawBehandlingshistorikEvent) => ev.occurred_at >= window.fromTs && ev.occurred_at <= window.toTs
  for (const fact of companyFacts) raw.push(...companyFactEvents(fact, (p) => predicateDef(p)?.label ?? p).filter(inWindow))
  raw.push(...arkivActivityEvents(arkivActivities).filter(inWindow))
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
  // Invoices handed over to collection, the provider closing a case, and the company's decisions on it.
  const caseById = new Map(collectionCases.map((c) => [c.id, c]))
  for (const row of collectionCases) {
    for (const ev of collectionCaseEvents(row)) {
      if (isWithin(ev.occurred_at, fromMs, toMsBound)) raw.push(ev)
    }
  }
  for (const row of collectionDecisions) {
    if (isWithin(row.occurred_at, fromMs, toMsBound)) raw.push(collectionDecisionEvent(row, caseById.get(row.case_id)))
  }
  // Beslut och förslag: each decision read as its receipt (suggestions on
  // offer, the one taken, who decided, the agent proposal that carried it
  // and the person the agent staged it for, named before the details are
  // written).
  const userLabels = new Map<string, string>()
  if (decisions.rows.length > 0) {
    const receipts = await withProposalSponsors(supabase, companyId, buildDecisionReceipts(decisions.rows, decisions.context))
    const sponsorIds = [...new Set(receipts.map((r) => r.proposed_by?.user_id).filter((id): id is string => !!id))]
    if (options.resolveUserLabels && sponsorIds.length > 0) {
      for (const [id, label] of await options.resolveUserLabels(sponsorIds)) userLabels.set(id, label)
    }
    raw.push(...decisionEvents(receipts, userLabels))
  }

  let events = collapseBursts(sortEvents(raw))
  if (params.categories && params.categories.length > 0) {
    const wanted = new Set(params.categories)
    events = events.filter((e) => wanted.has(e.category))
  }

  const userIds = [
    ...new Set(events.flatMap((e) => [e.actor.user_id, e.verified?.user_id]).filter((id): id is string => !!id && !userLabels.has(id))),
  ]
  if (options.resolveUserLabels && userIds.length > 0) {
    for (const [id, label] of await options.resolveUserLabels(userIds)) userLabels.set(id, label)
  }
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
      actorWithVerified(e),
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

export async function buildBehandlingshistorikExport(
  report: BehandlingshistorikReport,
  format: 'xlsx' | 'csv',
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const specs = behandlingshistorikSheetSpecs(report)
  const date = report.mode === 'fiscal_year' ? report.period.end : report.range.to
  if (format === 'csv') {
    // CSV carries the first sheet only; the metadata sheet is xlsx-only.
    const buf = await reportToWorkbook([specs[0]], { bookType: 'csv' })
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
    buffer: await reportToWorkbook(specs),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: exportFilename('behandlingshistorik', report.company.name, date, 'xlsx'),
  }
}
