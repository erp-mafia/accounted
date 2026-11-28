/**
 * Voucher series resolver: pure helpers for mapping journal_entries.source_type
 * to a default voucher_series per company_settings, formatting voucher labels
 * for display, and parsing them back.
 *
 * Source-type → series mapping lives in
 *   company_settings.default_voucher_series_per_source_type (JSONB).
 *
 * Defaults to 'A' when:
 *   - the settings row is null/undefined
 *   - the JSONB is missing the source_type key (and the key it inherits
 *     from, see SERIES_INHERITED_FROM)
 *   - the configured value is not a single uppercase letter A-Z
 *
 * These functions are pure; no I/O. Engine call-sites read the settings row
 * once and pass it in.
 */
import type { JournalEntrySourceType } from '@/types'

export type VoucherSeriesMap = Partial<Record<JournalEntrySourceType, string>> &
  Record<string, string>

const SERIES_LETTER_RE = /^[A-Z]$/

/**
 * The conventional Swedish verifikationsserier and what each one is for.
 *
 * The column accepts any A-Z letter. The pickers list this set first, with
 * these names, and the remaining letters after it (buildVoucherSeriesOptions),
 * so the conventional layout is what a company sees first while a ledger that
 * gives its letters other meanings (S for skattekontot) can keep them.
 *
 * The letters are NOT prescribed by law: BFL 5 kap. 7 § only requires an
 * unbroken, systematically ordered numbering within each series. This list is
 * Fortnox's, taken verbatim from their Systemdokumentation (Fortnox Lön,
 * section 4 Behandlingsregler), because Fortnox is the system most companies
 * migrate here from and an imported ledger should keep its meaning. Note that
 * the incumbents disagree with each other: Björn Lundén uses F for
 * kundfakturor, L for leverantörsfakturor and N for löner. The one point
 * they agree on is that A is the general series you post manual entries into,
 * which is where STANDARD_VOUCHER_SERIES_MAP below keeps everything that is
 * not a reskontra, lön, moms, periodisering or bokslut flow.
 *
 * The labels are bookkeeping-domain terms that stay Swedish in both locales,
 * same convention as VoucherSeriesPerSourceTypeForm.
 */
export const VOUCHER_SERIES_PRESETS: ReadonlyArray<{ letter: string; label: string }> = [
  { letter: 'A', label: 'Redovisning' },
  { letter: 'B', label: 'Kundfakturor' },
  { letter: 'C', label: 'Inbetalningar från kunder' },
  { letter: 'D', label: 'Leverantörsfakturor' },
  { letter: 'E', label: 'Utbetalningar till leverantörer' },
  { letter: 'F', label: 'Kassa' },
  { letter: 'G', label: 'Avskrivning' },
  { letter: 'H', label: 'Periodisering' },
  { letter: 'I', label: 'Bokslut' },
  { letter: 'J', label: 'Revisor' },
  { letter: 'K', label: 'Lön' },
  { letter: 'L', label: 'Kontantfaktura' },
  { letter: 'M', label: 'Momsrapport' },
]

/**
 * Company-defined series names, company_settings.voucher_series_labels:
 * {"L": "Lön"}. Keys are single uppercase letters, values non-empty names.
 */
export type VoucherSeriesLabels = Partial<Record<string, string>>

/**
 * Display name for a series letter: the company's own name first, the Swedish
 * preset second, empty when neither exists. The ONLY place that decides what a
 * letter is called; every picker and list goes through it so a company that
 * lays its series out differently from the presets (L for löner instead of K)
 * sees its own words everywhere, not Fortnox's.
 */
export function voucherSeriesLabel(
  letter: string,
  labels?: VoucherSeriesLabels | null,
): string {
  const custom = labels?.[letter]
  if (typeof custom === 'string' && custom.trim().length > 0) return custom.trim()
  const match = VOUCHER_SERIES_PRESETS.find((p) => p.letter === letter)
  return match ? match.label : ''
}

/** Every letter a voucher series can be: one uppercase letter, A-Z. */
const SERIES_LETTERS: readonly string[] = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/**
 * The list every series picker offers: the presets in their fixed order, then
 * every other single letter A-Z in alphabetical order. Each entry carries the
 * display name resolved by voucherSeriesLabel, so a custom name overrides a
 * preset in place and a non-preset letter shows the company's name for it, or
 * none.
 *
 * Still a fixed list, never free text: a series is one letter A-Z, the same
 * rule the settings schema and the DB columns hold. Any letter is lawful:
 * BFL 5 kap. 7 § asks for an unbroken, systematically ordered numbering within
 * each series, and commit_journal_entry numbers each letter on its own per
 * company and räkenskapsår. BFNAR 2013:2 p. 9.2-9.15 wants the series in use
 * enumerated in the systemdokumentation, which lists every series that has
 * vouchers (voucher_sequences) and every configured one, under the company's
 * name for it or "Egen serie", so a letter outside the presets is documented
 * the moment it is used.
 */
export function buildVoucherSeriesOptions(
  labels: VoucherSeriesLabels | null | undefined,
): Array<{ letter: string; label: string }> {
  const presetLetters = new Set(VOUCHER_SERIES_PRESETS.map((p) => p.letter))
  return [
    ...VOUCHER_SERIES_PRESETS.map((p) => p.letter),
    ...SERIES_LETTERS.filter((letter) => !presetLetters.has(letter)),
  ].map((letter) => ({ letter, label: voucherSeriesLabel(letter, labels) }))
}

/**
 * The series layout a new company starts with, and what "Använd
 * standarduppsättningen" under Inställningar > Bokföring fills in for an
 * existing one. The DB column default (migration 20260906210500) is this map
 * verbatim; tests/pg/voucher-series-standard-default.pg.test.ts holds the two
 * equal.
 *
 * The letters are the presets above, so every series in the set already has
 * a name in the pickers and a ledger imported from Fortnox continues its
 * kundfakturor in B, leverantörsfakturor in D and löner in K instead of
 * starting parallel series next to them. The principle: the flows a reader
 * of the verifikationslista wants to see apart (kundfakturor, inbetalningar,
 * leverantörsfakturor, utbetalningar, periodisering, bokslut, lön, moms) get
 * their own series; everything else stays in A, the general series.
 *
 * Exhaustive over JournalEntrySourceType on purpose. Before this map the
 * column default was "everything on A" and the resolver's 'A' fallback let
 * every source type added since (webshop_order, vat_settlement,
 * expense_payout, ...) join that series without anyone deciding; a new
 * source type now fails to compile until it has a letter here.
 *
 * resolveDefaultSeriesForSource never reads this map. A company whose row
 * predates it keeps 'A' for every type until it applies the set itself:
 * remapping a live ledger by migration would move, say, the next kundfaktura
 * from A341 into a fresh B1 mid-year with nothing in the behandlingshistorik
 * saying who decided it. BFNAR 2013:2 p. 9.16 records changes to the
 * behandlingsregler with date and actor; the settings save gives that, a
 * migration cannot.
 */
export const STANDARD_VOUCHER_SERIES_MAP: Readonly<Record<JournalEntrySourceType, string>> = {
  manual: 'A',
  bank_transaction: 'A',
  invoice_created: 'B',
  credit_note: 'B',
  reminder_fee: 'B',
  invoice_paid: 'C',
  invoice_cash_payment: 'C',
  rot_rut_payout: 'C',
  rot_rut_reclaim: 'C',
  collection_settlement: 'C',
  rot_rut_reclassification: 'C',
  supplier_invoice_registered: 'D',
  supplier_credit_note: 'D',
  supplier_invoice_privately_paid: 'D',
  supplier_invoice_paid: 'E',
  supplier_invoice_cash_payment: 'E',
  accrual: 'H',
  year_end: 'I',
  result_appropriation: 'I',
  salary_payment: 'K',
  webshop_order: 'L',
  pos_daily_sales: 'F',
  vat_settlement: 'M',
  opening_balance: 'A',
  currency_revaluation: 'A',
  inbox_item: 'A',
  import: 'A',
  system: 'A',
  tax_account: 'A',
  storno: 'A',
  correction: 'A',
  stripe_payout: 'A',
  expense_claim: 'A',
  expense_payout: 'A',
  // Kundförlust adjusts kundfordringar already booked in B and C; it is
  // neither a kundfaktura nor an inbetalning, so the general series.
  customer_loss: 'A',
  // Kvittning settles a kundfordran against a leverantörsskuld; no money
  // moves, so neither inbetalning (C) nor utbetalning (E): the general series.
  counterparty_setoff: 'A',
}

/**
 * True when `map` assigns every source type exactly the standard letter.
 * The settings form uses it to disable "Använd standarduppsättningen" once
 * the draft already is the standard set. Extra keys are ignored: a map that
 * carries a letter for a source type this build does not know is still
 * "on the standard set" for every type it can book.
 */
export function isStandardVoucherSeriesMap(
  map: VoucherSeriesMap | null | undefined,
): boolean {
  if (!map || typeof map !== 'object') return false
  return (Object.keys(STANDARD_VOUCHER_SERIES_MAP) as JournalEntrySourceType[]).every(
    (sourceType) => map[sourceType] === STANDARD_VOUCHER_SERIES_MAP[sourceType],
  )
}

/**
 * Source types split off an older one: a map saved before the split has no
 * key for the new type, so it resolves to the letter of the type it was split
 * from, the series those bookings used until then. Skattekonto bookings were
 * 'system' until #172 gave them 'tax_account'; a company that moved 'system'
 * to another series keeps its skattekonto there until it sets Skattekonto
 * itself.
 */
const SERIES_INHERITED_FROM: Readonly<Partial<Record<JournalEntrySourceType, JournalEntrySourceType>>> = {
  tax_account: 'system',
}

/**
 * Resolve the default voucher_series letter for a given source_type from a
 * company_settings row. Returns 'A' as a safe fallback when no mapping is
 * configured for that source_type (nor for the type it inherits from, see
 * SERIES_INHERITED_FROM).
 *
 * @param settings - Either a full CompanySettings row or just the per-source
 *                   map. `null`/`undefined` is allowed (returns 'A').
 * @param sourceType - The journal_entries.source_type value.
 */
export function resolveDefaultSeriesForSource(
  settings:
    | { default_voucher_series_per_source_type?: VoucherSeriesMap | null }
    | VoucherSeriesMap
    | null
    | undefined,
  sourceType: JournalEntrySourceType,
): string {
  if (!settings) return 'A'

  // Accept both the full settings row and a bare map. Both shapes are
  // narrowed via duck-typing on the column key: when present, treat it as
  // the settings row; otherwise treat the argument itself as the map.
  const raw = settings as {
    default_voucher_series_per_source_type?: VoucherSeriesMap | null
  } & VoucherSeriesMap
  const mapCandidate =
    raw.default_voucher_series_per_source_type !== undefined
      ? raw.default_voucher_series_per_source_type
      : (settings as VoucherSeriesMap)

  if (!mapCandidate || typeof mapCandidate !== 'object') return 'A'

  const map = mapCandidate as VoucherSeriesMap
  const value = map[sourceType]
  if (typeof value === 'string' && SERIES_LETTER_RE.test(value)) {
    return value
  }
  const inheritedFrom = SERIES_INHERITED_FROM[sourceType]
  const inherited = inheritedFrom ? map[inheritedFrom] : undefined
  if (typeof inherited === 'string' && SERIES_LETTER_RE.test(inherited)) {
    return inherited
  }
  return 'A'
}

/**
 * Propagate a change to the global default voucher series across the
 * per-source-type map. Source types that were still following the previous
 * default move to the new default; explicit overrides (values that differ from
 * the previous default) are preserved untouched.
 *
 * The booking engine resolves series from the per-source-type map, not from the
 * global default, so the bookkeeping settings form calls this when the user
 * changes the "Standardserie" dropdown, otherwise that control would be a
 * no-op for bookkeeping. Pure; returns the next map (input is not mutated).
 */
export function applyDefaultSeriesToMap(
  currentMap: VoucherSeriesMap | null | undefined,
  prevDefault: string,
  nextDefault: string,
): VoucherSeriesMap {
  const out: VoucherSeriesMap = {}
  for (const [key, value] of Object.entries(currentMap || {})) {
    out[key] = value === prevDefault ? nextDefault : value
  }
  return out
}

/**
 * Format a voucher (series + number) for display: "A113". This is the one
 * voucher reference format, for the UI, messages, exports and agent text;
 * never build `${series}${number}` by hand (check:guards, hand-built-voucher-ref).
 * Returns "-" when the voucher number is null or 0 (a draft that has not been
 * committed yet).
 *
 * Always lifts the series to uppercase. Falls back to 'A' when the series is
 * null/empty for forward-compat with legacy rows. Accepts partial inputs so
 * callsites can pass through API responses without re-shaping them.
 *
 * `separator: '-'` gives "A-113". It exists only for the v1 API fields that
 * are documented in that form (voucher_label on the transaction voucher link,
 * the compliance check and existing opening balances): their values are a
 * public contract. parseVoucher reads both forms.
 */
export function formatVoucher(
  entry: {
    voucher_series?: string | null
    voucher_number?: number | null
  },
  options: { separator?: '' | '-' } = {},
): string {
  if (entry.voucher_number == null || entry.voucher_number === 0) {
    return '-'
  }
  const series =
    entry.voucher_series && typeof entry.voucher_series === 'string'
      ? entry.voucher_series.toUpperCase()
      : 'A'
  return `${series}${options.separator ?? ''}${entry.voucher_number}`
}

/**
 * Parse a formatted voucher label back into its parts. Returns null when the
 * input does not match the expected shape: a single letter followed by a
 * positive integer, optionally separated by one space or hyphen ("A209",
 * "a 209", "A-209"). Use for filter inputs / search: these are the shapes
 * users type when they look for a voucher by its number.
 */
export function parseVoucher(
  formatted: string,
): { series: string; number: number } | null {
  if (typeof formatted !== 'string') return null
  const trimmed = formatted.trim().toUpperCase()
  const match = trimmed.match(/^([A-Z])[ -]?(\d+)$/)
  if (!match) return null
  const number = parseInt(match[2], 10)
  if (!Number.isFinite(number) || number <= 0) return null
  return { series: match[1], number }
}
