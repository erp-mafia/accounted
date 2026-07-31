import type { SupabaseClient } from '@supabase/supabase-js'
import type { SourceSignals } from './schemas'
import { loadActiveEmployeeCount } from './employee-facts'

// Atom registry index row: the metadata-only shape the composer sees when
// picking a loadout. We never send full atom bodies to the Opus call;
// metadata is enough for selection.
export interface AtomRegistryIndexRow {
  id: string
  tier: 'horizontal' | 'vertical' | 'modifier'
  title: string
  description: string
  sni_prefixes: string[]
  trigger_signals: Record<string, unknown>
  estimated_tokens: number
  version: number
}

export async function loadAtomRegistryIndex(
  supabase: SupabaseClient,
): Promise<AtomRegistryIndexRow[]> {
  const { data, error } = await supabase
    .from('agent_atom_registry')
    .select('id, tier, title, description, sni_prefixes, trigger_signals, estimated_tokens, version')
    .eq('is_active', true)
    .is('parent_atom_id', null) // top-level skills only; reference children are load-on-demand
    .order('id')
  if (error) throw new Error(`Failed to load agent_atom_registry: ${error.message}`)
  return (data ?? []) as AtomRegistryIndexRow[]
}

export async function loadCompanyTicSnapshot(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ snapshot: Record<string, unknown> | null; fetchedAt: string | null; name: string; entityType: string }> {
  const { data, error } = await supabase
    .from('companies')
    .select('name, entity_type, tic_snapshot, tic_snapshot_fetched_at')
    .eq('id', companyId)
    .single()
  if (error) throw new Error(`Failed to load company ${companyId}: ${error.message}`)
  return {
    snapshot: (data?.tic_snapshot as Record<string, unknown> | null) ?? null,
    fetchedAt: (data?.tic_snapshot_fetched_at as string | null) ?? null,
    name: data?.name ?? '',
    entityType: data?.entity_type ?? '',
  }
}

// Known facts from `company_settings`: the settings forms persist these
// (moms_period, fiscal_year_start_month, f_skatt, employer facts, city).
// Composer uses them as KNOWN inputs so it stops generating verification
// questions about already-settled values.
//
// Employees are NOT in here as a headcount: this select used to name
// `employee_count` and `has_employees`, neither of which exists on
// company_settings, which made PostgREST reject the whole select (42703) and
// left every field below null too. The employer facts that do exist are
// `employer_registered` (nullable: null = never attested) and `pays_salaries`;
// lib/agent/composer/employee-facts.ts turns them plus the live `employees`
// count into the derived answer.
export interface CompanySettingsForComposer {
  city: string | null
  moms_period: string | null
  fiscal_year_start_month: number | null
  f_skatt: boolean | null
  vat_registered: boolean | null
  employer_registered: boolean | null
  pays_salaries: boolean | null
  accounting_method: string | null
}

export async function loadCompanySettings(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanySettingsForComposer | null> {
  const { data } = await supabase
    .from('company_settings')
    .select(
      'city, moms_period, fiscal_year_start_month, f_skatt, vat_registered, employer_registered, pays_salaries, accounting_method',
    )
    .eq('company_id', companyId)
    .maybeSingle()
  return (data ?? null) as CompanySettingsForComposer | null
}

// Whether the currently-onboarding user is a confirmed director / signatory
// at this company per BankID CompanyRoles. When true, the narrative is safe
// to use second-person ownership voice ("Du driver…"); when false (manual-
// orgnr signup, accountant-on-behalf-of, etc.) the narrative falls back to
// neutral third-person ("Coredination AB är…") so we don't put words about
// ownership in the user's mouth.
//
// We match the user's enrichment row against this company's org_number.
// `companyId` is the Accounted UUID: we need to read the orgnr from
// `companies` to do the match. Cheap (single SELECT each) and only runs once
// per agent build.
//
// Director-like positions per Bolagsverket: 'ceo', 'boardMember', 'chairman',
// 'externalSignatory'. Deputy positions ('deputyBoardMember') and external
// auditors are intentionally excluded: they don't run the company day-to-day.
const DIRECTOR_POSITION_TYPES = new Set([
  'ceo',
  'boardMember',
  'chairman',
  'externalSignatory',
  // Lowercase variants in case TIC normalises differently
  'CEO',
  'BoardMember',
  'Chairman',
  'ExternalSignatory',
])

export async function loadUserDirectorship(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ confirmedDirector: boolean }> {
  // Read this company's org_number: the BankID CompanyRoles row keys on
  // companyRegistrationNumber, not the Accounted company UUID.
  const { data: companyRow } = await supabase
    .from('companies')
    .select('org_number')
    .eq('id', companyId)
    .single()
  const orgNumber = (companyRow?.org_number as string | null)?.replace(/[\s-]/g, '')
  if (!orgNumber) return { confirmedDirector: false }

  // Read the active user's enrichment row. Composer runs inside the user's
  // request context (RLS-scoped client), so .maybeSingle() only sees the row
  // for the authenticated user: no need to join through company_members.
  const { data: enrichmentRow } = await supabase
    .from('bankid_enrichment')
    .select('company_roles')
    .maybeSingle()
  const roles = (enrichmentRow?.company_roles ?? []) as Array<{
    companyRegistrationNumber?: string
    positionTypes?: string[]
    positionEnd?: string | null
  }>
  if (!Array.isArray(roles) || roles.length === 0) return { confirmedDirector: false }

  const match = roles.find(
    (r) => r.companyRegistrationNumber?.replace(/[\s-]/g, '') === orgNumber,
  )
  if (!match) return { confirmedDirector: false }

  // Position must be a director-type AND not already ended.
  const nowIso = new Date().toISOString()
  if (match.positionEnd && match.positionEnd < nowIso) return { confirmedDirector: false }
  const positions = match.positionTypes ?? []
  const isDirector = positions.some((p) => DIRECTOR_POSITION_TYPES.has(p))
  return { confirmedDirector: isDirector }
}

// ---------------------------------------------------------------------------
// Currency-aware magnitudes
// ---------------------------------------------------------------------------
//
// `transactions.amount` is denominated in `transactions.currency`, not in SEK.
// The SEK value of a foreign row lives in `amount_sek` (written at ingest) or
// is derivable from `exchange_rate`; a foreign row carrying neither has no
// known SEK value at all. Adding raw `amount` across rows and labelling the
// total "kr" therefore invents a magnitude out of thin air.
//
// That matters more here than in an ordinary report: these summaries are the
// input to the model that writes the company's standing agent instructions, so
// a wrong magnitude is baked into durable instructions rather than misleading
// one answer. Every rollup below therefore carries three things instead of one
// number: the SEK total of the rows whose SEK value is actually known, the
// native total per currency (covering every row), and the count of rows
// deliberately left out of the SEK total.
export interface CurrencyMagnitude {
  // SEK total of the rows with a known SEK value. 0 when no row has one, so
  // always read `rows_without_sek` before treating this as the magnitude.
  //
  // Named `abs_amount` (not `abs_amount_sek`) because `SourceSignals` persists
  // this shape in `agent_profiles.source_signals`; renaming would silently
  // change what older snapshots mean.
  abs_amount: number
  // Native totals per currency, covering EVERY row including the ones with no
  // SEK equivalent. SEK first, then descending. Amounts in different
  // currencies are never added together.
  by_currency: { currency: string; abs_amount: number }[]
  // Rows with a foreign amount and neither `amount_sek` nor a usable
  // `exchange_rate`. These are NOT part of `abs_amount`.
  rows_without_sek: number
}

interface AmountRow {
  amount: number | string | null
  currency?: string | null
  amount_sek?: number | string | null
  exchange_rate?: number | string | null
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function rowCurrency(row: AmountRow): string {
  const raw = typeof row.currency === 'string' ? row.currency.trim().toUpperCase() : ''
  return raw.length > 0 ? raw : 'SEK'
}

// SEK value of one row, or null when there genuinely is none. Mirrors the
// resolution order used when booking (lib/bookkeeping/currency-utils.ts) but
// deliberately drops its final fallback: that one returns the raw foreign
// amount when no rate is stored, which for a summary reads as "500 EUR is
// 500 kr". For this input a missing rate must read as unknown.
function rowSekAmount(row: AmountRow): number | null {
  const amount = toFiniteNumber(row.amount)
  if (amount == null) return null
  if (rowCurrency(row) === 'SEK') return Math.abs(amount)
  const stored = toFiniteNumber(row.amount_sek)
  if (stored != null) return Math.abs(stored)
  const rate = toFiniteNumber(row.exchange_rate)
  if (rate == null || rate <= 0) return null
  return Math.abs(amount * rate)
}

interface MagnitudeBucket {
  sek: number
  native: Map<string, number>
  rowsWithoutSek: number
}

function newMagnitudeBucket(): MagnitudeBucket {
  return { sek: 0, native: new Map(), rowsWithoutSek: 0 }
}

// Folds one row into a bucket and returns its SEK value (null when unknown).
// Rows with no usable `amount` at all are skipped rather than counted as a
// currency gap: they are missing data, not a missing exchange rate.
function addRowToMagnitude(bucket: MagnitudeBucket, row: AmountRow): number | null {
  const amount = toFiniteNumber(row.amount)
  if (amount == null) return null
  const currency = rowCurrency(row)
  bucket.native.set(currency, (bucket.native.get(currency) ?? 0) + Math.abs(amount))
  const sek = rowSekAmount(row)
  if (sek == null) {
    bucket.rowsWithoutSek++
  } else {
    bucket.sek += sek
  }
  return sek
}

function finalizeMagnitude(bucket: MagnitudeBucket): CurrencyMagnitude {
  const by_currency = Array.from(bucket.native.entries())
    .map(([currency, abs_amount]) => ({
      currency,
      abs_amount: Math.round(abs_amount * 100) / 100,
    }))
    .sort((a, b) => {
      if (a.currency === b.currency) return 0
      if (a.currency === 'SEK') return -1
      if (b.currency === 'SEK') return 1
      return b.abs_amount - a.abs_amount
    })
  return {
    abs_amount: Math.round(bucket.sek * 100) / 100,
    by_currency,
    rows_without_sek: bucket.rowsWithoutSek,
  }
}

// True when the whole magnitude is plain SEK with nothing unresolved, i.e. the
// only case where it may be rendered as a single "kr" figure.
export function isSekOnlyMagnitude(m: CurrencyMagnitude): boolean {
  return m.rows_without_sek === 0 && m.by_currency.every((c) => c.currency === 'SEK')
}

// Ranking key for magnitudes with no usable SEK total: the largest single
// currency total. Ordering only, never rendered, so it never implies that
// amounts in different currencies are comparable money.
function largestNativeTotal(m: CurrencyMagnitude): number {
  return m.by_currency.reduce((max, c) => (c.abs_amount > max ? c.abs_amount : max), 0)
}

// Splits a counterparty rollup into a SEK-ranked top list plus the ones whose
// magnitude cannot be expressed in SEK and would otherwise vanish at the
// slice (they rank as 0 kr). The second list is what keeps "no stored exchange
// rate" visible instead of silently excluded.
function rankCounterparties<T extends CurrencyMagnitude & { name: string }>(
  rows: T[],
  topLimit: number,
  unconvertibleLimit: number,
): { top: T[]; unconvertible: T[] } {
  const ranked = [...rows].sort((a, b) => b.abs_amount - a.abs_amount)
  const top = ranked.slice(0, topLimit)
  const inTop = new Set(top.map((r) => r.name))
  const unconvertible = ranked
    .filter((r) => r.rows_without_sek > 0 && !inTop.has(r.name))
    .sort((a, b) => largestNativeTotal(b) - largestNativeTotal(a))
    .slice(0, unconvertibleLimit)
  return { top, unconvertible }
}

interface CounterpartyMagnitude extends CurrencyMagnitude {
  name: string
}

interface SieSummary {
  top_accounts: { account: string; abs_amount: number }[]
  top_counterparties: CounterpartyMagnitude[]
  // Counterparties left out of the SEK ranking because no row carries a SEK
  // equivalent. Rendered in their own labelled block so they stay visible.
  unconvertible_counterparties: CounterpartyMagnitude[]
  year_count: number
}

// Build a coarse SIE summary from the most-recent imported SIE for the
// company. Used by the composer as a verticality signal (e.g. a top-spend
// account 1465, alcohol inventory, strongly suggests restaurang).
//
// Returns null when no SIE has been imported. The composer must still work
// without SIE data; TIC sniCodes carry most of the signal on their own.
export async function loadSieSummary(
  supabase: SupabaseClient,
  companyId: string,
): Promise<SieSummary | null> {
  const { data: imports, error: importsErr } = await supabase
    .from('sie_imports')
    .select('id, fiscal_year_start, fiscal_year_end')
    .eq('company_id', companyId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(20)
  if (importsErr) return null
  if (!imports || imports.length === 0) return null

  // Fiscal-year span across all completed imports (approximate).
  const years = new Set(
    imports.map((r: { fiscal_year_start: string | null }) => {
      const v = r.fiscal_year_start
      return v ? v.slice(0, 4) : ''
    }),
  )
  years.delete('')

  // Top-20 account magnitudes across journal_entry_lines for the company.
  // Cheaper than aggregating SIE line-items directly because the lines have
  // already landed in journal_entry_lines after import. These are genuinely
  // SEK: journal_entry_lines.debit/credit are the booked SEK amounts, with any
  // foreign original kept separately in currency/amount_in_currency.
  const { data: lines, error: linesErr } = await supabase.rpc('agent_top_accounts_for_company', {
    p_company_id: companyId,
    p_limit: 20,
  })

  // RPC is optional: if it doesn't exist yet, fall back to an inline group-by.
  // Either way, we tolerate missing data and return what we have.
  let topAccounts: { account: string; abs_amount: number }[] = []
  if (!linesErr && Array.isArray(lines)) {
    topAccounts = (lines as { account_number: string; abs_amount: number }[]).map((l) => ({
      account: l.account_number,
      abs_amount: Number(l.abs_amount) || 0,
    }))
  }

  // Coarse counterparty rollup off the bank-statement description string.
  // `transactions.description` is the raw text from the bank (not
  // normalized) so this is a noisy signal. The composer treats it as a hint
  // alongside TIC sniCodes, which carry the strong industry signal.
  //
  // currency/amount_sek/exchange_rate come along because `amount` alone does
  // not say what unit it is in: see the CurrencyMagnitude note above.
  const { data: tx } = await supabase
    .from('transactions')
    .select('description, amount, currency, amount_sek, exchange_rate')
    .eq('company_id', companyId)
    .limit(2000)

  const cpAgg = new Map<string, MagnitudeBucket>()
  if (Array.isArray(tx)) {
    for (const t of tx as (AmountRow & { description: string | null })[]) {
      const name = normalizeCounterparty(t.description)
      if (!name) continue
      let bucket = cpAgg.get(name)
      if (!bucket) {
        bucket = newMagnitudeBucket()
        cpAgg.set(name, bucket)
      }
      addRowToMagnitude(bucket, t)
    }
  }
  const allCounterparties: CounterpartyMagnitude[] = Array.from(cpAgg.entries()).map(
    ([name, bucket]) => ({ name, ...finalizeMagnitude(bucket) }),
  )
  const { top, unconvertible } = rankCounterparties(allCounterparties, 10, 5)

  return {
    top_accounts: topAccounts,
    top_counterparties: top,
    unconvertible_counterparties: unconvertible,
    year_count: years.size,
  }
}

interface BankingCounterparty extends CounterpartyMagnitude {
  // 'in'  → money coming in (income / refund / loan disbursement)
  // 'out' → money going out (cost / supplier payment / repayment)
  // 'mixed' → both directions present (rare: typically transfers or
  //           returns). The composer should not assume a category from
  //           mixed counterparties.
  direction: 'in' | 'out' | 'mixed'
  // True when at least one transaction for this counterparty still has
  // journal_entry_id IS NULL. Composer should only generate verification
  // questions about counterparties where this is true: the others are
  // already settled and re-asking wastes the user's time.
  has_unbooked: boolean
}

interface BankingSummary {
  top_counterparties: BankingCounterparty[]
  // Counterparties whose amounts include rows with no stored SEK equivalent
  // and that did not survive the SEK ranking. Kept so "we do not know what
  // this is worth in kronor" stays visible instead of silently excluded.
  unconvertible_counterparties: BankingCounterparty[]
  // Average monthly SEK volume over the window, counting ONLY rows whose SEK
  // value is known. null when no row has one: there is then no honest kr
  // figure to state at all.
  monthly_volume: number | null
  // Coverage behind `monthly_volume`. When rows_without_sek > 0 the figure is
  // a floor, not the real volume, and the renderer has to say so.
  volume_rows_with_sek: number
  volume_rows_without_sek: number
  // Every currency seen in the window, e.g. ['EUR', 'SEK'].
  currencies: string[]
  unbooked_count: number
}

// POC: re-use transactions table for banking counterparties. A first-class
// Enable Banking summary lives behind the enable-banking extension and is
// post-POC.
//
// Booking-aware: each rolled-up counterparty carries `direction` (sign of
// the transactions) and `has_unbooked` (any row without journal_entry_id).
// Both signals exist to keep the composer from asking dumb questions:
// "is this a cost or an income?" when the sign is clearly negative,
// "how should this be booked?" when there's no unbooked transaction left.
export async function loadBankingSummary(
  supabase: SupabaseClient,
  companyId: string,
): Promise<BankingSummary | null> {
  // currency/amount_sek/exchange_rate are part of the magnitude, not optional
  // decoration: without them `amount` is a bare number with no unit, and the
  // rollup below would sum EUR into a total labelled "kr".
  const { data, error } = await supabase
    .from('transactions')
    .select('description, amount, currency, amount_sek, exchange_rate, date, journal_entry_id')
    .eq('company_id', companyId)
    .gte('date', oneYearAgo())
    .order('date', { ascending: false })
    .limit(5000)
  if (error || !Array.isArray(data) || data.length === 0) return null

  interface Bucket {
    magnitude: MagnitudeBucket
    hasInflow: boolean
    hasOutflow: boolean
    hasUnbooked: boolean
  }
  const cpAgg = new Map<string, Bucket>()
  const currencies = new Set<string>()
  let sekVolume = 0
  let volumeRowsWithSek = 0
  let volumeRowsWithoutSek = 0
  let unbookedCount = 0
  for (const t of data as (AmountRow & {
    description: string | null
    journal_entry_id: string | null
  })[]) {
    if (!t.journal_entry_id) unbookedCount++

    const signedAmt = toFiniteNumber(t.amount)
    if (signedAmt != null) {
      currencies.add(rowCurrency(t))
      const sek = rowSekAmount(t)
      if (sek == null) {
        volumeRowsWithoutSek++
      } else {
        sekVolume += sek
        volumeRowsWithSek++
      }
    }

    const name = normalizeCounterparty(t.description)
    if (!name) continue
    let bucket = cpAgg.get(name)
    if (!bucket) {
      bucket = {
        magnitude: newMagnitudeBucket(),
        hasInflow: false,
        hasOutflow: false,
        hasUnbooked: false,
      }
      cpAgg.set(name, bucket)
    }
    addRowToMagnitude(bucket.magnitude, t)
    // Direction reads off the sign, which is currency-independent.
    if (signedAmt != null && signedAmt > 0) bucket.hasInflow = true
    if (signedAmt != null && signedAmt < 0) bucket.hasOutflow = true
    if (!t.journal_entry_id) bucket.hasUnbooked = true
  }
  const allCounterparties: BankingCounterparty[] = Array.from(cpAgg.entries()).map(
    ([name, b]) => ({
      name,
      ...finalizeMagnitude(b.magnitude),
      direction: b.hasInflow && b.hasOutflow ? 'mixed' : b.hasInflow ? 'in' : 'out',
      has_unbooked: b.hasUnbooked,
    }),
  )
  const { top, unconvertible } = rankCounterparties(allCounterparties, 20, 10)

  return {
    top_counterparties: top,
    unconvertible_counterparties: unconvertible,
    monthly_volume: sekVolume > 0 ? Math.round(sekVolume / 12) : null,
    volume_rows_with_sek: volumeRowsWithSek,
    volume_rows_without_sek: volumeRowsWithoutSek,
    currencies: Array.from(currencies).sort(),
    unbooked_count: unbookedCount,
  }
}

function oneYearAgo(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return d.toISOString().slice(0, 10)
}

// Cheap counterparty extraction from a bank-statement description. Strips
// reference numbers, dates, and common suffixes; truncates to ~40 chars.
// Post-POC: replace with the matcher in lib/transactions/.
function normalizeCounterparty(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw
    .replace(/\b\d{4,}\b/g, ' ')       // strip long digit runs (refs)
    .replace(/[/*:|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return cleaned.length >= 3 ? cleaned : null
}

// Composite input for the Opus selection call.
export interface ComposerInputs {
  companyId: string
  companyName: string
  entityType: string
  ticSnapshot: Record<string, unknown> | null
  ticFetchedAt: string | null
  companySettings: CompanySettingsForComposer | null
  // Employees currently flagged active in the payroll module. null when the
  // count could not be read, which must not be read as "nobody": see
  // lib/agent/composer/employee-facts.ts.
  activeEmployees: number | null
  sieSummary: SieSummary | null
  bankingSummary: BankingSummary | null
  atomIndex: AtomRegistryIndexRow[]
  // True when BankID CompanyRoles confirms the active user holds a
  // director-like position at this company. Controls whether the narrative
  // uses second-person ownership voice ("Du driver…") or neutral
  // third-person ("Coredination AB är…"). Default false so unknown users
  // never get the presumptive voice.
  userIsConfirmedDirector: boolean
}

export async function gatherComposerInputs(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ComposerInputs> {
  const [
    { snapshot, fetchedAt, name, entityType },
    atomIndex,
    sieSummary,
    bankingSummary,
    companySettings,
    activeEmployees,
    directorship,
  ] = await Promise.all([
    loadCompanyTicSnapshot(supabase, companyId),
    loadAtomRegistryIndex(supabase),
    loadSieSummary(supabase, companyId).catch(() => null),
    loadBankingSummary(supabase, companyId).catch(() => null),
    loadCompanySettings(supabase, companyId).catch(() => null),
    loadActiveEmployeeCount(supabase, companyId).catch(() => null),
    loadUserDirectorship(supabase, companyId).catch(() => ({ confirmedDirector: false })),
  ])

  return {
    companyId,
    companyName: name,
    entityType,
    ticSnapshot: snapshot,
    ticFetchedAt: fetchedAt,
    companySettings,
    activeEmployees,
    sieSummary,
    bankingSummary,
    atomIndex,
    userIsConfirmedDirector: directorship.confirmedDirector,
  }
}

export function inputsToSourceSignals(inputs: ComposerInputs): SourceSignals {
  return {
    tic: inputs.ticSnapshot,
    sie_summary: inputs.sieSummary,
    banking_summary: inputs.bankingSummary,
    atom_registry_version: inputs.atomIndex.reduce((acc, a) => acc + a.version, 0),
  }
}
