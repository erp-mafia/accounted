import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchEntriesWithAccountLines } from '@/lib/bookkeeping/entry-lines'
import { chunk, formatCurrency, formatWholeKr } from '@/lib/utils'
import {
  INVOICE_SOURCED_ENTRY_TYPES,
  LINK_LOOKUP_CHUNK,
  getInvoicesExplainingJournalEntries,
} from '@/lib/core/bookkeeping/journal-entry-references'
import { calculatePeriodDates, formatPeriodLabel } from './period-dates'
import {
  ACCOUNT_RUTA,
  VAT_ACCOUNTS,
  VAT_SETTLEMENT_NET_ACCOUNTS,
  calculateVatDeclaration,
} from './vat-declaration'
import { fetchDynamicVatAccounts } from './vat-revenue-accounts'
import { normalizeCountryCode } from '@/lib/vat/country-codes'

/**
 * Periodisk sammanställning (EC Sales List / SKV 5740).
 *
 * Pure projection from the general ledger: posted journal entry lines on the
 * accounts the momsdeklaration puts in rutor 39 (services, BAS 3308), 35
 * (goods, BAS 3108) and 38 (triangulation, BAS 3107) are joined back to the
 * originating invoice and customer to produce one row per (country,
 * vat_number) with three amount buckets.
 *
 * The PS is the per-buyer breakdown of rutor 35, 38 and 39, so it reads the
 * same account-to-ruta mapping the declaration does, the company's own
 * momskod on an account included (crm#1336): every line the declaration
 * counts there is either filed under a buyer or reported, never dropped.
 *
 * Notes:
 *   - Which invoice a posting belongs to is resolved through every link the
 *     register keeps (the engine's source_id, invoices.journal_entry_id,
 *     invoice_payments.journal_entry_id), so a SIE-imported sale matched to
 *     its invoice afterwards and a kontantmetod inbetalning are filed too
 *     (#2298). A storno or rättelse of such a posting is filed under the
 *     same invoice by following reverses_id / correction_of_id (#2351), so a
 *     makulerad sale nets to zero here exactly as it does in ruta 39.
 *   - A posting no invoice points at (a manual, imported or bank-booked EU
 *     sale) has no buyer VAT number to file it under. It cannot be filed,
 *     but the declaration counts it, so it is reported as an
 *     UNATTRIBUTED_EU_SALE naming the verifikat (crm#1336): blocking on
 *     ruta 35/38 (goods are always reported per buyer), a warning on ruta
 *     39 (a service is owed a row only when the buyer has a VAT number and
 *     it is taxed in the buyer's country). Before, it was left out silently
 *     and the report could read "no EU sales" while ruta 39 held the sale.
 *   - Account 3305/3105 (non-EU export) are NOT in this report: they go to
 *     Ruta 36/40 only.
 *   - Trepartshandel (3107) is included so the report works if someone posts
 *     there manually; the invoicing UI doesn't post there today (v2).
 *   - Avropslager codes X/Y/Z are deferred to v2: the CSV serializer asserts
 *     only numeric amounts in v1.
 */

export type PsPeriodType = 'monthly' | 'quarterly'

export interface PsRow {
  country: string              // 2-char, EL for Grekland
  vatNumber: string            // normalized, no country prefix
  services: number             // typ 3 (account 3308), hela kronor
  goods: number                // typ 1 (account 3108)
  triangulation: number        // typ 2 (account 3107)
  customerId: string | null
  customerName: string | null
  hasBlockingIssue: boolean
}

export type PsWarningCode =
  | 'MISSING_COUNTRY'
  | 'MISSING_VAT_NUMBER'
  | 'VIES_UNVALIDATED'
  | 'COUNTRY_PREFIX_MISMATCH'
  | 'NON_EU_COUNTRY_ON_EU_ACCOUNT'
  | 'CUSTOMER_NOT_FOUND'
  | 'ZERO_NET_EXCLUDED'
  | 'GOODS_SOLD_WITH_QUARTERLY_PERIOD'
  /** One verifikat linked to invoices of different customers: cannot be split per customer. */
  | 'MIXED_CUSTOMER_SETTLEMENT'
  /** A posted EU sale the declaration counts but no invoice names a buyer for. */
  | 'UNATTRIBUTED_EU_SALE'
  /** A bucket's total differs from the ruta the declaration counts for the same dates. */
  | 'RUTA_DIFFERENCE'

export interface PsWarning {
  level: 'error' | 'warning'
  code: PsWarningCode
  message: string
  customerId?: string
  customerName?: string
  invoiceId?: string
  /** The verifikat a MIXED_CUSTOMER_SETTLEMENT or UNATTRIBUTED_EU_SALE warning is about. */
  journalEntryId?: string
  /** Its voucher label ("A66"). */
  voucher?: string
  /** The momsdeklaration ruta an UNATTRIBUTED_EU_SALE or RUTA_DIFFERENCE is about. */
  ruta?: '35' | '38' | '39'
  /**
   * How the buyer is added for an UNATTRIBUTED_EU_SALE: register the customer
   * invoice against the verifikat (any currency its 151x lines carry), which
   * links it and files the sale under that customer's VAT number.
   */
  resolveWith?: 'register_booked_invoice'
  amount?: number
}

export interface PeriodiskSammanstallningReport {
  period: {
    type: PsPeriodType
    year: number
    period: number
    start: string
    end: string
    label: string
  }
  rows: PsRow[]
  warnings: PsWarning[]
  totals: {
    services: number
    goods: number
    triangulation: number
    grand: number
    rowCount: number
  }
  reconciliation: {
    ruta39: number | null
    ruta35: number | null
    ruta38: number | null
    matches: boolean | null
    tolerance: number
  }
}

/** ISO 3166-1 alpha-2 codes for EU member states (post-Brexit, excl. UK). */
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
  'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
])

/** Skatteverket uses EL for Greece; ISO uses GR. */
function toVatCountryCode(iso: string): string {
  return iso === 'GR' ? 'EL' : iso.toUpperCase()
}

type PsBucket = 'services' | 'goods' | 'triangulation'

/** The momsdeklaration ruta each PS bucket breaks down per buyer. */
const RUTA_TO_BUCKET: Readonly<Record<string, PsBucket>> = {
  ruta39: 'services',
  ruta35: 'goods',
  ruta38: 'triangulation',
}

const BUCKET_RUTA: Readonly<Record<PsBucket, '35' | '38' | '39'>> = { services: '39', goods: '35', triangulation: '38' }

/**
 * The company's PS accounts and the bucket each feeds, resolved the way the
 * declaration resolves its rutor (and the ruta drill-down inverts them): the
 * fixed BAS map minus the accounts the company classified itself, then the
 * company's own classification. A hardcoded 3308/3108/3107 list missed every
 * EU sale on an account the company gave an EU momskod, while ruta 35/39 kept it.
 */
async function resolvePsAccountBuckets(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Map<string, PsBucket>> {
  const dynamic = await fetchDynamicVatAccounts(supabase, companyId)
  const buckets = new Map<string, PsBucket>()
  for (const [account, mapping] of Object.entries(ACCOUNT_RUTA)) {
    const bucket = RUTA_TO_BUCKET[mapping.box]
    if (bucket && !dynamic.explicitAccounts.has(account)) buckets.set(account, bucket)
  }
  for (const [account, mapping] of dynamic.mappingByAccount) {
    const bucket = RUTA_TO_BUCKET[mapping.box]
    if (bucket) buckets.set(account, bucket)
  }
  return buckets
}

/** get_vat_ruta_source_lines caps a page at 501 rows. */
const SOURCE_LINES_PAGE = 500

/**
 * Ids of the verifikat the momsdeklaration counts on these accounts in the
 * period. Read through get_vat_ruta_source_lines, the ruta drill-down's RPC,
 * with the declaration's own settlement-shape parameters, so it drops what
 * the figure drops (the posted bokslut, momsredovisningar, the kontantmetod
 * cut-off reversals) and nothing else. There is deliberately no TypeScript
 * copy of those exclusions.
 */
async function fetchDeclaredEntryIds(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
  accounts: string[],
): Promise<Set<string>> {
  const ids = new Set<string>()
  let cursor: { date: string; voucher: number; entryId: string; lineId: string } | null = null
  for (;;) {
    const { data, error } = await supabase.rpc('get_vat_ruta_source_lines', {
      p_company_id: companyId,
      p_start: start,
      p_end: end,
      p_accounts: accounts,
      p_ruta_accounts: VAT_ACCOUNTS,
      p_net_accounts: VAT_SETTLEMENT_NET_ACCOUNTS,
      p_cursor_date: cursor?.date ?? null,
      p_cursor_voucher_number: cursor?.voucher ?? null,
      p_cursor_entry_id: cursor?.entryId ?? null,
      p_cursor_line_id: cursor?.lineId ?? null,
      p_limit: SOURCE_LINES_PAGE,
    })
    if (error) throw new Error(`get_vat_ruta_source_lines failed: ${error.message}`)
    const rows = (data ?? []) as Array<{
      line_id: string
      journal_entry_id: string
      voucher_number: number
      entry_date: string
    }>
    for (const row of rows) ids.add(row.journal_entry_id)
    if (rows.length < SOURCE_LINES_PAGE) return ids
    const last = rows[rows.length - 1]
    cursor = { date: last.entry_date, voucher: last.voucher_number, entryId: last.journal_entry_id, lineId: last.line_id }
  }
}

interface RawEntryLine {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
}

interface RawEntry {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  status: string
  source_type: string | null
  source_id: string | null
  /** Storno: the entry this one cancels; its invoice explains this one too. */
  reverses_id: string | null
  /** Rättelse: the entry this one replaces; likewise. */
  correction_of_id: string | null
  /** Only the PS-account lines: the embed is filtered on account_number. */
  journal_entry_lines: RawEntryLine[] | null
}

type FlatLine = RawEntryLine & { entry: RawEntry }

interface RawInvoice {
  id: string
  customer_id: string | null
  customer: {
    id: string
    name: string
    country: string | null
    vat_number: string | null
    vat_number_validated: boolean | null
    vat_number_validated_at: string | null
  } | null
}

/**
 * Strip optional leading country prefix and whitespace; uppercase the rest.
 *
 * Examples:
 *   "SE556677889901" → "556677889901"
 *   "  de 123456789  " → "123456789"
 *   "el123" → "123"
 */
export function normalizeVatNumber(raw: string | null | undefined): string {
  if (!raw) return ''
  const stripped = raw.replace(/\s+/g, '').toUpperCase()
  // Skatteverket prefixes are two letters; EL is intentionally treated the same.
  if (/^[A-Z]{2}/.test(stripped)) return stripped.slice(2)
  return stripped
}

function round(value: number): number {
  return Math.round(value)
}

/** Voucher label for messages ("A123"), or the id when the entry has none. */
function voucherLabel(entry: RawEntry): string {
  return entry.voucher_number ? formatVoucher(entry) : entry.id
}

/** Net credit of the entry's PS-account lines: what the file would carry. */
function entryNet(entry: RawEntry): number {
  let net = 0
  for (const line of entry.journal_entry_lines ?? []) {
    net += (Number(line.credit_amount) || 0) - (Number(line.debit_amount) || 0)
  }
  return net
}

/**
 * Who a linked invoice is filed under: the customer row plus the (country,
 * VAT number) pair its PS row would carry. Two invoices agree only when all
 * of it agrees; an invoice that could not be loaded is its own unknown party.
 */
function customerIdentity(invoice: RawInvoice | undefined, invoiceId: string): string {
  const customer = invoice?.customer
  if (!customer) return `unknown:${invoiceId}`
  const country = (customer.country ?? '').trim().toUpperCase()
  return `${customer.id}|${country}|${normalizeVatNumber(customer.vat_number)}`
}

/**
 * The entry a storno or rättelse chain starts at, within the fetched period:
 * the unattributed lines of an original, its storno and its correction are
 * one sale and net together, as they do in ruta 39.
 */
function chainRoot(entry: RawEntry, byId: Map<string, RawEntry>): RawEntry {
  const seen = new Set<string>([entry.id])
  let current = entry
  for (;;) {
    const parentId = current.reverses_id ?? current.correction_of_id
    const parent = parentId ? byId.get(parentId) : undefined
    if (!parent || seen.has(parent.id)) return current
    seen.add(parent.id)
    current = parent
  }
}

function byVoucherOrder(a: RawEntry, b: RawEntry): number {
  if (a.entry_date !== b.entry_date) return a.entry_date < b.entry_date ? -1 : 1
  return (a.voucher_number ?? 0) - (b.voucher_number ?? 0)
}

/**
 * One UNATTRIBUTED_EU_SALE per sale (chain) and account: the posted EU-sale
 * amount the declaration counts but no invoice names a buyer for. Blocking
 * for goods and trepartshandel, a warning for services (see below).
 * A chain that nets to zero (a makulerad manual sale) is in neither figure
 * and is not reported.
 */
function unattributedWarnings(
  lines: Array<FlatLine & { bucket: PsBucket }>,
  byId: Map<string, RawEntry>,
): PsWarning[] {
  const groups = new Map<string, { account: string; bucket: PsBucket; net: number; members: Map<string, RawEntry> }>()
  for (const line of lines) {
    const key = `${chainRoot(line.entry, byId).id}|${line.account_number}`
    let group = groups.get(key)
    if (!group) {
      group = { account: line.account_number, bucket: line.bucket, net: 0, members: new Map() }
      groups.set(key, group)
    }
    group.net += (Number(line.credit_amount) || 0) - (Number(line.debit_amount) || 0)
    group.members.set(line.entry.id, line.entry)
  }

  const warnings: PsWarning[] = []
  for (const group of groups.values()) {
    const amount = Math.round(group.net * 100) / 100
    if (amount === 0) continue
    const members = Array.from(group.members.values()).sort(byVoucherOrder)
    // The verifikat to act on: the latest one still posted (a correction
    // rather than the original it replaced).
    const live = members.filter((e) => e.status === 'posted').pop() ?? members[members.length - 1]
    const what =
      `Verifikat ${members.map(voucherLabel).join(', ')} (${live.entry_date}) bokför ${formatCurrency(amount)} ` +
      `på konto ${group.account} (ruta ${BUCKET_RUTA[group.bucket]}) utan någon kundfaktura som anger köparens VAT-nummer`
    // Services: a PS row is owed only when the buyer has a VAT number and the
    // service is taxed in the buyer's country, so ruta 39 may legitimately
    // differ from the list; the file stays allowed. Goods and trepartshandel
    // (ruta 35/38): every such sale is reported per buyer and the
    // exemption rests on it, so the file is refused until it is.
    warnings.push(group.bucket === 'services'
      ? {
          level: 'warning',
          code: 'UNATTRIBUTED_EU_SALE',
          message:
            `${what}, så sammanställningen kan vara ofullständig. Om köparen har ett VAT-nummer och tjänsten ` +
            'beskattas i köparens land ska köparen redovisas: koppla verifikatet till kundfakturan, eller lägg till ' +
            'raden i Skatteverkets e-tjänst.',
          journalEntryId: live.id,
          voucher: voucherLabel(live),
          ruta: BUCKET_RUTA[group.bucket],
          resolveWith: 'register_booked_invoice',
          amount,
        }
      : {
          level: 'error',
          code: 'UNATTRIBUTED_EU_SALE',
          message:
            `${what}. Försäljningen ingår i momsdeklarationen men saknas i sammanställningen, och en EU-varuförsäljning ` +
            'ska alltid redovisas per köpare. Koppla verifikatet till kundfakturan, eller lämna sammanställningen i ' +
            'Skatteverkets e-tjänst och ta med köparen där.',
          journalEntryId: live.id,
          voucher: voucherLabel(live),
          ruta: BUCKET_RUTA[group.bucket],
          resolveWith: 'register_booked_invoice',
          amount,
        })
  }
  return warnings
}

/**
 * The ledger side of the PS for [start, end]: the company's PS accounts, the
 * posted verifikat on them and the register invoices that explain each one.
 */
interface PsLedger {
  accountBuckets: Map<string, PsBucket>
  psAccounts: string[]
  entries: RawEntry[]
  invoiceIdsByEntry: Map<string, string[]>
}

/**
 * The period's posted and reversed verifikat with a posting on a PS account,
 * each with just those lines, ordered by id. No source_type filter: which
 * register invoice a posting belongs to is resolved through every link the
 * register keeps, not only the engine's own source columns.
 *
 * One get_entries_with_account_lines call, which reads only the days the PS
 * accounts moved. The paged PostgREST read below gives the same rows for a
 * database without the function yet; it ordered by id across every tenant's
 * entries and took over a second for a busy company's month.
 */
async function fetchPsEntries(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
  psAccounts: string[],
): Promise<RawEntry[]> {
  const rows = await fetchEntriesWithAccountLines(supabase, companyId, {
    start,
    end,
    accounts: psAccounts,
    statuses: ['posted', 'reversed'],
    allLines: false,
  })
  if (rows) {
    return rows.map((row) => ({
      id: row.id,
      voucher_series: row.voucher_series,
      voucher_number: row.voucher_number,
      entry_date: row.entry_date,
      status: row.status,
      source_type: row.source_type,
      source_id: row.source_id,
      reverses_id: row.reverses_id,
      correction_of_id: row.correction_of_id,
      journal_entry_lines: row.lines.map((line) => ({
        account_number: line.account_number,
        debit_amount: line.debit_amount,
        credit_amount: line.credit_amount,
      })),
    }))
  }

  // Driven from journal_entries (company + date indexed) with the EU-revenue
  // condition as an inner embed, so only entries carrying a posting on a PS
  // account come back, with just those lines. Never the inverse shape (lines
  // with an entries embed): see lib/bookkeeping/entry-lines.ts.
  return fetchAllRows<RawEntry>(({ from, to }) =>
    supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number, entry_date, status, source_type, source_id, reverses_id, correction_of_id, journal_entry_lines!inner(account_number, debit_amount, credit_amount)')
      .eq('company_id', companyId)
      .in('status', ['posted', 'reversed'])
      .gte('entry_date', start)
      .lte('entry_date', end)
      .in('journal_entry_lines.account_number', psAccounts)
      // Stable total order for correct paging (see fetch-all.ts).
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: RawEntry[] | null; error: { message: string } | null }>,
  )
}

async function loadPsLedger(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
): Promise<PsLedger> {
  const accountBuckets = await resolvePsAccountBuckets(supabase, companyId)
  const psAccounts = Array.from(accountBuckets.keys())
  const entries = await fetchPsEntries(supabase, companyId, start, end, psAccounts)

  // Which register invoice does each posting belong to? Four links; only
  // the first lives on the entry itself:
  //   1. the engine's own entries: source_id IS the invoice id;
  //   2. invoices.journal_entry_id (registration booking, backfilled);
  //   3. invoice_payments.journal_entry_id: kontantmetod inbetalning,
  //      delbetalning, and "matcha mot befintligt verifikat", which is how a
  //      SIE-imported sale gets its invoice after migration (#2298);
  //   4. reverses_id / correction_of_id: a storno or rättelse is explained by
  //      whatever explains the entry it cancels or replaces (#2351). The
  //      reversed original stays in the fetch (status 'reversed'), so its
  //      storno must be filed under the same invoice or the makulerad sale
  //      is over-reported while ruta 39 nets it to zero.
  // Following 1 alone (the old source_type filter) dropped every linked
  // import and every kontantmetod sale from the filing while the
  // account-based momsdeklaration kept showing them in ruta 39.
  // Every invoice each entry resolves to. The engine's own entries name one
  // (source_id); a linked entry may name several when one inbetalning settled
  // several invoices. All of them are kept so the report can tell "two
  // invoices, one customer" from "two customers on one posting".
  const invoiceIdsByEntry = await getInvoicesExplainingJournalEntries(supabase, companyId, entries)

  return { accountBuckets, psAccounts, entries, invoiceIdsByEntry }
}

/**
 * A manual, imported or bank-booked verifikat no register invoice points at:
 * there is no buyer to file it under (see the header). The engine's own
 * entries never qualify: an engine entry whose invoice is gone is a data
 * defect, reported as CUSTOMER_NOT_FOUND.
 */
function hasNoBuyer(entry: RawEntry, ledger: PsLedger): boolean {
  return !ledger.invoiceIdsByEntry.get(entry.id) && !INVOICE_SOURCED_ENTRY_TYPES.has(entry.source_type ?? '')
}

/**
 * What the PS cannot file but the declaration counts (crm#1336). A chain
 * that nets to zero is in neither figure, so the declaration is asked only
 * when an amount is left; it decides which verifikat count (the posted
 * bokslut zeroing 3308 is no sale).
 */
async function declaredUnattributedWarnings(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
  ledger: PsLedger,
  unattributed: Array<FlatLine & { bucket: PsBucket }>,
): Promise<PsWarning[]> {
  if (unattributed.length === 0) return []
  const byId = new Map(ledger.entries.map((entry) => [entry.id, entry]))
  if (unattributedWarnings(unattributed, byId).length === 0) return []
  const declared = await fetchDeclaredEntryIds(supabase, companyId, start, end, ledger.psAccounts)
  return unattributedWarnings(unattributed.filter((line) => declared.has(line.entry.id)), byId)
}

/**
 * The UNATTRIBUTED_EU_SALE findings of the PS for any date range: the EU
 * sales the momsdeklaration counts in rutor 35, 38 and 39 that no invoice
 * names a buyer for, with the PS's own severity (error on 35/38, warning on
 * 39). The VAT close check reads them for its momsperiod, a helårsmoms year
 * included, so "can I close" and the PS never disagree (crm#1362).
 */
export async function findUnattributedEuSales(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
): Promise<PsWarning[]> {
  const ledger = await loadPsLedger(supabase, companyId, start, end)
  const unattributed: Array<FlatLine & { bucket: PsBucket }> = []
  for (const entry of ledger.entries) {
    if (!hasNoBuyer(entry, ledger)) continue
    for (const line of entry.journal_entry_lines ?? []) {
      const bucket = ledger.accountBuckets.get(line.account_number)
      if (bucket) unattributed.push({ ...line, entry, bucket })
    }
  }
  return declaredUnattributedWarnings(supabase, companyId, start, end, ledger, unattributed)
}

interface Accumulator {
  country: string
  vatNumber: string
  customerId: string | null
  customerName: string | null
  services: number
  goods: number
  triangulation: number
  blocking: boolean
  /** True once we've seen any non-zero posting, even if it later nets to zero. */
  sawActivity: boolean
}

export async function generatePeriodiskSammanstallning(
  supabase: SupabaseClient,
  companyId: string,
  periodType: PsPeriodType,
  year: number,
  period: number,
): Promise<PeriodiskSammanstallningReport> {
  if (periodType !== 'monthly' && periodType !== 'quarterly') {
    throw new Error(`Invalid PS periodType: ${periodType}`)
  }
  if (periodType === 'monthly' && (period < 1 || period > 12)) {
    throw new Error(`Invalid monthly period: ${period}`)
  }
  if (periodType === 'quarterly' && (period < 1 || period > 4)) {
    throw new Error(`Invalid quarterly period: ${period}`)
  }

  const { start, end } = calculatePeriodDates(periodType, year, period)
  const ledger = await loadPsLedger(supabase, companyId, start, end)
  const { accountBuckets, entries, invoiceIdsByEntry } = ledger

  const allInvoiceIds = new Set<string>()
  for (const ids of invoiceIdsByEntry.values()) for (const id of ids) allInvoiceIds.add(id)

  const invoiceMap = new Map<string, RawInvoice>()
  for (const ids of chunk(Array.from(allInvoiceIds), LINK_LOOKUP_CHUNK)) {
    const invoices = await fetchAllRows<RawInvoice>(({ from, to }) =>
      supabase
        .from('invoices')
        .select(`
          id,
          customer_id,
          customer:customers (
            id,
            name,
            country,
            vat_number,
            vat_number_validated,
            vat_number_validated_at
          )
        `)
        .eq('company_id', companyId)
        .in('id', ids)
        // Stable total order for correct paging (see fetch-all.ts).
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: RawInvoice[] | null; error: { message: string } | null }>,
    )
    for (const inv of invoices) invoiceMap.set(inv.id, inv)
  }

  // One flat line list with its parent entry, in entry-id then line order.
  const lines: FlatLine[] = []
  for (const entry of entries) {
    for (const line of entry.journal_entry_lines ?? []) lines.push({ ...line, entry })
  }

  const accumulators = new Map<string, Accumulator>()
  const warnings: PsWarning[] = []
  let goodsLineSeen = false
  // Verifikat already reported as MIXED_CUSTOMER_SETTLEMENT: one warning per
  // verifikat, not one per line.
  const mixedReported = new Set<string>()
  // Postings no register invoice points at: no buyer to file them under.
  const unattributed: Array<FlatLine & { bucket: PsBucket }> = []

  for (const line of lines) {
    const bucket = accountBuckets.get(line.account_number)
    if (!bucket) continue
    const invoiceIds = invoiceIdsByEntry.get(line.entry.id)
    // No buyer to file it under: reported below instead. An engine entry
    // whose invoice is gone falls through to CUSTOMER_NOT_FOUND below.
    if (hasNoBuyer(line.entry, ledger)) {
      unattributed.push({ ...line, bucket })
      continue
    }
    if (bucket === 'goods' || bucket === 'triangulation') goodsLineSeen = true

    // One posting, several invoices (a deposit settling more than one): fine
    // while they are the same customer, undecidable when they are not. The
    // ledger cannot split the line per customer, so the verifikat is kept out
    // of the file and reported as blocking, the way CUSTOMER_NOT_FOUND is.
    if (invoiceIds && invoiceIds.length > 1) {
      const customers = new Set(invoiceIds.map((id) => customerIdentity(invoiceMap.get(id), id)))
      if (customers.size > 1) {
        if (!mixedReported.has(line.entry.id)) {
          mixedReported.add(line.entry.id)
          warnings.push({
            level: 'error',
            code: 'MIXED_CUSTOMER_SETTLEMENT',
            message:
              `Verifikat ${voucherLabel(line.entry)} är kopplat till fakturor från ${customers.size} olika kunder ` +
              'och kan inte fördelas per kund i sammanställningen. Kontrollera kopplingarna innan inlämning.',
            journalEntryId: line.entry.id,
            amount: entryNet(line.entry),
          })
        }
        continue
      }
    }
    const invoice = invoiceIds ? invoiceMap.get(invoiceIds[0]) ?? null : null

    const debit = Number(line.debit_amount) || 0
    const credit = Number(line.credit_amount) || 0
    const net = credit - debit

    const customer = invoice?.customer ?? null

    if (!invoice || !customer) {
      warnings.push({
        level: 'error',
        code: 'CUSTOMER_NOT_FOUND',
        message: 'Kund saknas på faktura. Kontakta support innan inlämning.',
        invoiceId: invoice?.id,
        amount: net,
      })
      bucketRow(accumulators, '??', '??', null, null, bucket, net, true)
      continue
    }

    // Rows written before 2026-09 may still hold a country name the
    // backfill could not map; a name the register knows becomes its code, an
    // unknown one is kept as typed so the warning names it.
    const isoCountry = normalizeCountryCode(customer.country) ?? (customer.country ?? '').trim().toUpperCase()
    const vatCountry = isoCountry ? toVatCountryCode(isoCountry) : ''
    const rawVat = customer.vat_number ?? ''
    const normalizedVat = normalizeVatNumber(rawVat)

    let blocking = false

    if (!isoCountry) {
      warnings.push({
        level: 'error',
        code: 'MISSING_COUNTRY',
        message: `Kund "${customer.name}" saknar land. Uppdatera kunden innan CSV laddas ner.`,
        customerId: customer.id,
        customerName: customer.name,
        invoiceId: invoice.id,
        amount: net,
      })
      blocking = true
    } else if (!EU_COUNTRIES.has(isoCountry)) {
      warnings.push({
        level: 'warning',
        code: 'NON_EU_COUNTRY_ON_EU_ACCOUNT',
        message:
          `Konto ${line.account_number} men kund "${customer.name}" i ${isoCountry} ` +
          'är inte EU-land. Kontrollera bokföringen.',
        customerId: customer.id,
        customerName: customer.name,
        invoiceId: invoice.id,
        amount: net,
      })
      blocking = true
    }

    if (!normalizedVat) {
      warnings.push({
        level: 'error',
        code: 'MISSING_VAT_NUMBER',
        message: `Kund "${customer.name}" saknar VAT-nummer.`,
        customerId: customer.id,
        customerName: customer.name,
        invoiceId: invoice.id,
        amount: net,
      })
      blocking = true
    } else {
      // VAT prefix check: if the raw VAT-number starts with a country code,
      // it must match the customer.country. Skatteverket uses EL for Greece.
      const rawUpper = rawVat.replace(/\s+/g, '').toUpperCase()
      const prefixMatch = rawUpper.match(/^([A-Z]{2})/)
      if (prefixMatch && isoCountry) {
        const expected = toVatCountryCode(isoCountry)
        if (prefixMatch[1] !== expected) {
          warnings.push({
            level: 'warning',
            code: 'COUNTRY_PREFIX_MISMATCH',
            message:
              `VAT-nr för "${customer.name}" har prefix ${prefixMatch[1]} men ` +
              `kunden är registrerad i ${isoCountry}.`,
            customerId: customer.id,
            customerName: customer.name,
            invoiceId: invoice.id,
          })
        }
      }

      const validatedAt = customer.vat_number_validated_at
      const stale = validatedAt
        ? (Date.now() - new Date(validatedAt).getTime()) / (1000 * 60 * 60 * 24) > 30
        : true
      if (!customer.vat_number_validated || stale) {
        warnings.push({
          level: 'warning',
          code: 'VIES_UNVALIDATED',
          message:
            `Kund "${customer.name}" är inte VIES-validerad (eller validering äldre än 30 dagar). ` +
            'Verifiera mot Skatteverkets VIES-tjänst.',
          customerId: customer.id,
          customerName: customer.name,
        })
      }
    }

    bucketRow(
      accumulators,
      vatCountry || isoCountry || '??',
      normalizedVat || '??',
      customer.id,
      customer.name,
      bucket,
      net,
      blocking,
    )
  }

  warnings.push(...(await declaredUnattributedWarnings(supabase, companyId, start, end, ledger, unattributed)))

  // Goods-sold-with-quarterly-period: blocking under SFL 35 kap. 2 §.
  // Companies selling goods intra-EU must file PS monthly; a quarterly filing
  // is structurally non-compliant and must not be exportable as CSV.
  if (goodsLineSeen && periodType === 'quarterly') {
    warnings.push({
      level: 'error',
      code: 'GOODS_SOLD_WITH_QUARTERLY_PERIOD',
      message:
        'Du har varuförsäljning i perioden. Periodisk sammanställning för varor ska ' +
        'rapporteras månadsvis (35 kap. 2 § SFL). Byt period eller kontakta Skatteverket.',
    })
  }

  // Round, drop zero rows, sort.
  const rows: PsRow[] = []
  for (const acc of accumulators.values()) {
    const services = round(acc.services)
    const goods = round(acc.goods)
    const triangulation = round(acc.triangulation)
    if (services === 0 && goods === 0 && triangulation === 0) {
      // Emit a warning only if there was actual rörelse (a credit note nets
      // services back to zero: final values are 0 but we saw activity).
      if (acc.sawActivity) {
        warnings.push({
          level: 'warning',
          code: 'ZERO_NET_EXCLUDED',
          message:
            `Kund "${acc.customerName ?? acc.vatNumber}" nettar till 0 kr för perioden ` +
            '(kreditfaktura eller makulering tar ut originalet). Exkluderad från filen.',
          customerId: acc.customerId ?? undefined,
          customerName: acc.customerName ?? undefined,
        })
      }
      continue
    }
    rows.push({
      country: acc.country,
      vatNumber: acc.vatNumber,
      services,
      goods,
      triangulation,
      customerId: acc.customerId,
      customerName: acc.customerName,
      hasBlockingIssue: acc.blocking,
    })
  }

  rows.sort((a, b) => {
    if (a.country !== b.country) return a.country.localeCompare(b.country)
    return a.vatNumber.localeCompare(b.vatNumber)
  })

  const totals = {
    services: rows.reduce((s, r) => s + r.services, 0),
    goods: rows.reduce((s, r) => s + r.goods, 0),
    triangulation: rows.reduce((s, r) => s + r.triangulation, 0),
    grand: 0,
    rowCount: rows.length,
  }
  totals.grand = totals.services + totals.goods + totals.triangulation

  return {
    period: {
      type: periodType,
      year,
      period,
      start,
      end,
      label: formatPeriodLabel(periodType, year, period),
    },
    rows,
    warnings,
    totals,
    reconciliation: {
      ruta39: null,
      ruta35: null,
      ruta38: null,
      matches: null,
      tolerance: Math.max(1, Math.ceil(rows.length / 2)),
    },
  }
}

function bucketRow(
  map: Map<string, Accumulator>,
  country: string,
  vatNumber: string,
  customerId: string | null,
  customerName: string | null,
  bucket: 'services' | 'goods' | 'triangulation',
  amount: number,
  blocking: boolean,
): void {
  const key = `${country}|${vatNumber}|${customerId ?? ''}`
  let acc = map.get(key)
  if (!acc) {
    acc = {
      country,
      vatNumber,
      customerId,
      customerName,
      services: 0,
      goods: 0,
      triangulation: 0,
      blocking: false,
      sawActivity: false,
    }
    map.set(key, acc)
  }
  acc[bucket] += amount
  if (amount !== 0) acc.sawActivity = true
  if (blocking) acc.blocking = true
}

/**
 * RUTA_DIFFERENCE findings: one per bucket whose total is off the ruta the
 * declaration counts for the same dates by more than the rounding tolerance,
 * naming the difference and the verifikat without a buyer on that ruta
 * (crm#1336). A warning, never blocking: the UNATTRIBUTED_EU_SALE findings
 * already carry the severity per sale.
 */
export function reconciliationWarnings(
  report: PeriodiskSammanstallningReport,
  rutor: { ruta39: number; ruta35: number; ruta38: number },
): PsWarning[] {
  const warnings: PsWarning[] = []
  const tolerance = report.reconciliation.tolerance
  const checks: Array<{ bucket: PsBucket; label: string; listed: number; declared: number }> = [
    { bucket: 'services', label: 'tjänster', listed: report.totals.services, declared: rutor.ruta39 },
    { bucket: 'goods', label: 'varor', listed: report.totals.goods, declared: rutor.ruta35 },
    { bucket: 'triangulation', label: 'trepartshandel', listed: report.totals.triangulation, declared: rutor.ruta38 },
  ]
  for (const { bucket, label, listed, declared } of checks) {
    const difference = declared - listed
    if (Math.abs(difference) <= tolerance) continue
    const ruta = BUCKET_RUTA[bucket]
    const missing = report.warnings.filter((w) => w.code === 'UNATTRIBUTED_EU_SALE' && w.ruta === ruta)
    const which = missing.length > 0
      ? ` Verifikat utan köparens VAT-nummer: ${missing.map((w) => `${w.voucher ?? w.journalEntryId} (${formatCurrency(w.amount ?? 0)})`).join(', ')}. ` +
        'Registrera kundfakturan mot verifikatet, så redovisas försäljningen under köparen.'
      : ' Kontrollera bokföringen på EU-försäljningskontona.'
    warnings.push({
      level: 'warning',
      code: 'RUTA_DIFFERENCE',
      message:
        `Sammanställningen redovisar ${formatWholeKr(listed)} kr i ${label} men ruta ${ruta} i momsdeklarationen ` +
        `för samma period är ${formatWholeKr(declared)} kr, en skillnad på ${formatWholeKr(difference)} kr.${which}`,
      ruta,
      amount: difference,
    })
  }
  return warnings
}

/**
 * Cross-check PS totals against momsdeklaration Ruta 35/38/39 for the same
 * dates. Skatteverket matches the list against the rutor of the months it
 * covers, so a quarterly list of a monthly filer is checked against the
 * quarter's three months, which is the declaration over the quarter's dates.
 * Before, the check ran only when the two periods coincided, so a monthly
 * filer's quarterly list was never reconciled (crm#1336).
 */
export async function reconcilePsAgainstVatDeclaration(
  supabase: SupabaseClient,
  companyId: string,
  report: PeriodiskSammanstallningReport,
): Promise<PeriodiskSammanstallningReport> {
  const vat = await calculateVatDeclaration(
    supabase,
    companyId,
    report.period.type,
    report.period.year,
    report.period.period,
  )

  const rutor = {
    ruta35: Math.round(vat.rutor.ruta35),
    ruta38: Math.round(vat.rutor.ruta38 ?? 0),
    ruta39: Math.round(vat.rutor.ruta39),
  }
  const differences = reconciliationWarnings(report, rutor)

  return {
    ...report,
    warnings: [...report.warnings, ...differences],
    reconciliation: {
      ...rutor,
      matches: differences.length === 0,
      tolerance: report.reconciliation.tolerance,
    },
  }
}

export { formatPeriodLabel } from './period-dates'
