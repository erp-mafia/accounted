/**
 * What changed a filed momsdeklaration after it was filed: verifikat posted
 * into the filed period afterwards, rättelser of its verifikat, and dates
 * moved across its boundary.
 *
 * Filing freezes nothing. The ledger's freezes are the fiscal-year close and
 * lock and the company lock date, and a filing sets neither, so a back-dated
 * invoice, a correction on the original's date (storno-service keeps it) or a
 * voucher from an integration lands in a period Skatteverket already has. An
 * audit (2026-10-26) found about one filed declaration in eleven no longer matched the books,
 * and nothing had told the company. This says which filed period moved, by
 * how much per ruta, and through which verifikat. What the company does about
 * it (a corrected declaration, or moving the verifikat to an open period) is
 * its call; the change does not reach Skatteverket by itself.
 *
 * "After the filing" starts at the end of the Stockholm day of the latest
 * filing (a record carries the date only), and never before the period's own
 * last day (an old mark dated inside the period). The record keeps the first
 * filing date (a kvittens confirms a mark, it never moves it), so a corrected
 * declaration signed later through the Skatteverket connection is read from
 * the connection's own submission state: without it, every change the newer
 * declaration already carries would stay flagged. History imported after that
 * (the period was declared in an earlier system) is the books as filed: the
 * first import batch is the baseline and only what follows it counts.
 *
 * Which verifikat the rutor read is the SQL's decision, asked of the same
 * function get_vat_declaration_totals reads (vat_declaration_special_entries):
 * a tagged momsredovisning, the posted bokslut, a kontantmetod cut-off
 * reversal, a carried opening balance and a momsredovisning-shaped verifikat
 * are left out. Each counted verifikat moves the rutor by the fold the
 * declaration files (rutorChangeOfLines), with the company's own account
 * classification and the interim lines (17xx, 29xx) of a verifikat that books
 * a deferred or accrued invoice sale read as that sale (readDeferredSaleLines,
 * crm#1919): the invoice moves its whole sale, a month of its periodisering
 * nets to nothing.
 *
 * Only verifikat move a filed period here. A change to how the declaration
 * reads verifikat it already holds (crm#1919 read the 29xx and 17xx lines of
 * a periodiserad invoice into ruta 05) moves its figure without being listed.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { VatDeclarationRutor } from '@/types'
import { roundOre } from '@/lib/money'
import { endOfDayIsoStockholm, todayIsoStockholm } from '@/lib/dates/iso'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { mapWithConcurrency } from '@/lib/concurrency'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import {
  fetchInvoiceDeferralShares,
  readDeferredSaleLines,
  VAT_ACCOUNTS,
  VAT_SETTLEMENT_NET_ACCOUNTS,
  type InvoiceDeferralShares,
} from '@/lib/reports/vat-declaration'
import { fetchDynamicVatAccounts, type DynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import { createLogger } from '@/lib/logger'
import {
  momsredovisningShapeOfLines,
  rutorChangeOfLines,
  type VoucherImpactLine,
} from './voucher-vat-impact'
import type { VatFilingRecord } from './filing-record'
import { listVatFilings } from './filing-record-store'

const log = createLogger('vat/filed-period-changes')

type RutaKey = keyof VatDeclarationRutor
type RutorChange = Partial<Record<RutaKey, number>>
type ClassifiedAccounts = Pick<DynamicVatAccounts, 'mappingByAccount' | 'explicitAccounts'>

const RUTA_KEY = z.string().regex(/^ruta\d{2}$/)

export const VatFilingChangeSchema = z.object({
  changed_after: z
    .string()
    .describe('Changes count from this instant: the end of the filed day, or the end of a later history import.'),
  rutor_change: z
    .record(RUTA_KEY, z.number())
    .describe('Per ruta, the change since the filing, signed as filed (ruta49 positive = more moms att betala).'),
  verifikat: z
    .array(
      z.object({
        journal_entry_id: z.string().uuid(),
        voucher: z.string().describe('Series and number, e.g. A60.'),
        entry_date: z.string(),
        changed_at: z.string().describe('When it was posted, or when the rättelse was made.'),
        kind: z
          .enum(['posted', 'rattelse', 'redated'])
          .describe('posted: a verifikat posted after the filing; rattelse: lines corrected inline; redated: moved across the period boundary.'),
        rutor_change: z.record(RUTA_KEY, z.number()),
      }),
    )
    .describe('The verifikat behind the change, oldest first.'),
})

export type VatFilingChange = z.infer<typeof VatFilingChangeSchema> & { rutor_change: RutorChange }
export type VatFilingRecordWithChange = VatFilingRecord & { changed_after_filing: VatFilingChange | null }

/** Why vat_declaration_special_entries leaves a verifikat out of the rutor. */
const LEFT_OUT_REASONS = new Set(['kontantmetod_cutoff', 'carried_opening_balance', 'momsredovisning_shape'])

/** Ids per `.in()` filter: well inside PostgREST's URL limits. */
const IN_CHUNK = 200

interface EntryRow {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  source_type: string | null
  status: string
  committed_at: string | null
  created_at: string
  import_batch_id: string | null
}

interface RattelseRow {
  id: string
  journal_entry_id: string
  rattelse_type: 'metadata' | 'lines'
  old_entry_date: string | null
  new_entry_date: string | null
  struck_lines: VoucherImpactLine[] | null
  added_lines: VoucherImpactLine[] | null
  created_at: string
}

interface LineRow extends VoucherImpactLine {
  id: string
  journal_entry_id: string
}


function postedAt(entry: EntryRow): string {
  return entry.committed_at ?? entry.created_at
}

function addInto(target: RutorChange, change: RutorChange, sign: 1 | -1 = 1): void {
  for (const [box, amount] of Object.entries(change) as Array<[RutaKey, number]>) {
    target[box] = roundOre((target[box] ?? 0) + sign * amount)
  }
}

function moved(change: RutorChange): RutorChange {
  return Object.fromEntries(Object.entries(change).filter(([, amount]) => amount !== 0)) as RutorChange
}

/**
 * How one verifikat's lines move the rutor, read as the declaration reads
 * them: an interim line (17xx or 29xx) of a deferred or accrued invoice sale
 * counts as that sale (readDeferredSaleLines, crm#1919).
 */
function linesChange(
  entryId: string,
  lines: readonly VoucherImpactLine[] | null,
  accounts: ClassifiedAccounts,
  deferrals: InvoiceDeferralShares,
): RutorChange {
  return rutorChangeOfLines(
    readDeferredSaleLines(
      entryId,
      (lines ?? []).map((line) => ({
        account_number: line.account_number,
        debit_amount: Number(line.debit_amount) || 0,
        credit_amount: Number(line.credit_amount) || 0,
      })),
      deferrals,
    ),
    accounts,
  )
}

function inPeriod(date: string | null, filing: VatFilingRecord): boolean {
  return date !== null && filing.period_start <= date && date <= filing.period_end
}

const instant = (iso: string) => Date.parse(iso)

/**
 * The instant changes start counting for a filing, before history imports.
 * A signing through the connection on or after the record's date is the
 * latest filing and has an exact instant (the kvittens cron's), so it is
 * used as is. Otherwise the end of the record's filed day: a mark carries the
 * date only. Never before the end of the period's last day (an old mark dated
 * inside the period).
 */
export function filingBaseline(
  filing: Pick<VatFilingRecord, 'filed_on' | 'period_end'>,
  connectionSignedAt?: string | null,
): string {
  const periodEnd = endOfDayIsoStockholm(filing.period_end)
  if (connectionSignedAt && todayIsoStockholm(new Date(connectionSignedAt)) >= filing.filed_on) {
    return instant(connectionSignedAt) > instant(periodEnd) ? connectionSignedAt : periodEnd
  }
  return endOfDayIsoStockholm(filing.filed_on > filing.period_end ? filing.filed_on : filing.period_end)
}

/** The extension's key for a period's submission state: the period's last month, YYYYMM. */
function submissionKey(filing: Pick<VatFilingRecord, 'period_end'>): string {
  return `submission_${filing.period_end.slice(0, 4)}${filing.period_end.slice(5, 7)}`
}

/**
 * When each period was last signed through the Skatteverket connection, by
 * submission key: the kvittens cron's updatedAt on a `signed` submission
 * state (extension_data, extension skatteverket). Empty when the extension is
 * off or nothing was filed through it.
 */
async function connectionSignings(supabase: SupabaseClient, companyId: string): Promise<Map<string, string>> {
  const rows = await fetchAllRows<{ id: string; key: string; value: unknown }>(({ from, to }) =>
    supabase
      .from('extension_data')
      .select('id, key, value')
      .eq('company_id', companyId)
      .eq('extension_id', 'skatteverket')
      .like('key', 'submission_%')
      .order('id')
      .range(from, to),
  )
  const signedAt = new Map<string, string>()
  for (const row of rows) {
    const state = parseSubmissionState(row.value)
    if (state?.status !== 'signed' || typeof state.updatedAt !== 'string' || Number.isNaN(instant(state.updatedAt))) continue
    signedAt.set(row.key, state.updatedAt)
  }
  return signedAt
}

/** The stored submission state: a JSON object, or the same object stored as a JSON string. */
function parseSubmissionState(value: unknown): { status?: unknown; updatedAt?: unknown } | null {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as { status?: unknown; updatedAt?: unknown }
    } catch {
      // Not JSON: a state this module cannot read carries no signing date.
      return null
    }
  }
  return value && typeof value === 'object' ? (value as { status?: unknown; updatedAt?: unknown }) : null
}

/**
 * The baseline after history imported once the period was filed: the end of
 * the first import batch posted after `after`, or `after` itself.
 */
export function baselineAfterImports(entries: readonly EntryRow[], after: string): string {
  const imports = entries
    .filter((entry) => entry.source_type === 'import' && instant(postedAt(entry)) > instant(after))
    .sort((a, b) => instant(postedAt(a)) - instant(postedAt(b)))
  if (imports.length === 0) return after
  const first = imports[0]
  const batch = imports.filter((entry) =>
    first.import_batch_id === null ? entry.id === first.id : entry.import_batch_id === first.import_batch_id,
  )
  return batch.map(postedAt).reduce((latest, at) => (instant(at) > instant(latest) ? at : latest))
}

/** Filing periods read at the same time: bounded, so a long history never fans out unbounded. */
const FILING_READ_CONCURRENCY = 6

async function chunked<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) rows.push(...(await read(ids.slice(i, i + IN_CHUNK))))
  return rows
}

/**
 * Every filing record with the change made to its period since it was filed,
 * or null when the period's declaration still reads as filed. Read-only.
 */
export async function withChangesAfterFiling(
  supabase: SupabaseClient,
  companyId: string,
  filings: readonly VatFilingRecord[],
): Promise<VatFilingRecordWithChange[]> {
  if (filings.length === 0) return []
  const signings = await connectionSignings(supabase, companyId)
  const baselineOf = (filing: VatFilingRecord) => filingBaseline(filing, signings.get(submissionKey(filing)))
  const earliest = filings.map(baselineOf).reduce((min, at) => (instant(at) < instant(min) ? at : min))
  // The verifikat posted into each filed period after its baseline, read for
  // every filing at once (a few at a time): the VAT page waits on this, and a
  // monthly filer has 60 filings after five years, which read one after
  // another took over a second. Most periods have none, so the reads below
  // run only for the few that changed.
  const lateEntriesRead = mapWithConcurrency(filings, FILING_READ_CONCURRENCY, (filing) =>
    fetchAllRows<EntryRow>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id, voucher_series, voucher_number, entry_date, source_type, status, committed_at, created_at, import_batch_id')
        .eq('company_id', companyId)
        .in('status', ['posted', 'reversed'])
        .gte('entry_date', filing.period_start)
        .lte('entry_date', filing.period_end)
        // Every posted verifikat carries committed_at (set_committed_at
        // stamps the commit; none is null on seen 2026-10-28).
        .gt('committed_at', baselineOf(filing))
        .order('id')
        .range(from, to),
    ),
  )

  const [rattelser, closing, lateEntries] = await Promise.all([
    fetchAllRows<RattelseRow>(({ from, to }) =>
      supabase
        .from('journal_entry_rattelse_log')
        .select('id, journal_entry_id, rattelse_type, old_entry_date, new_entry_date, struck_lines, added_lines, created_at')
        .eq('company_id', companyId)
        .gt('created_at', earliest)
        .order('id')
        .range(from, to),
    ),
    fetchAllRows<{ closing_entry_id: string }>(({ from, to }) =>
      supabase
        .from('fiscal_periods')
        .select('closing_entry_id')
        .eq('company_id', companyId)
        .not('closing_entry_id', 'is', null)
        .order('id')
        .range(from, to),
    ),
    lateEntriesRead,
  ])
  const closingIds = new Set(closing.map((row) => row.closing_entry_id))
  const rattelseEntries = new Map(
    (
      await chunked([...new Set(rattelser.map((row) => row.journal_entry_id))], async (chunk) =>
        fetchAllRows<EntryRow>(({ from, to }) =>
          supabase
            .from('journal_entries')
            // Literal, not a shared constant: tests/schema/no-phantom-columns
            // checks selected columns against the schema and cannot see
            // through one.
            .select('id, voucher_series, voucher_number, entry_date, source_type, status, committed_at, created_at, import_batch_id')
            .eq('company_id', companyId)
            .in('id', chunk)
            .order('id')
            .range(from, to),
        ),
      )
    ).map((entry) => [entry.id, entry]),
  )

  let accounts: ClassifiedAccounts | null = null
  let deferrals: InvoiceDeferralShares | null = null
  let taxAccounts: string[] | null = null
  const result: VatFilingRecordWithChange[] = []

  for (const [index, filing] of filings.entries()) {
    const after = baselineOf(filing)
    const entries = lateEntries[index]
    const baseline = baselineAfterImports(entries, after)
    const late = entries.filter((entry) => instant(postedAt(entry)) > instant(baseline))
    const rattelseRows = rattelser.filter((row) => {
      if (instant(row.created_at) <= instant(baseline)) return false
      const entry = rattelseEntries.get(row.journal_entry_id)
      // A verifikat posted after the baseline is counted whole by its current
      // lines and date; only one the filing already read moves by a rättelse.
      if (!entry || instant(postedAt(entry)) > instant(baseline)) return false
      if (row.rattelse_type === 'lines') return inPeriod(entry.entry_date, filing)
      return row.old_entry_date !== row.new_entry_date &&
        inPeriod(row.old_entry_date, filing) !== inPeriod(row.new_entry_date, filing)
    })
    if (late.length === 0 && rattelseRows.length === 0) {
      result.push({ ...filing, changed_after_filing: null })
      continue
    }

    accounts ??= await fetchDynamicVatAccounts(supabase, companyId)
    deferrals ??= await fetchInvoiceDeferralShares(supabase, companyId)
    const { data: special, error: specialError } = await supabase.rpc('vat_declaration_special_entries', {
      p_company_id: companyId,
      p_start: filing.period_start,
      p_end: filing.period_end,
      p_net_shape_ruta_accounts: VAT_ACCOUNTS,
      p_net_shape_net_accounts: VAT_SETTLEMENT_NET_ACCOUNTS,
      p_ruta_accounts: VAT_ACCOUNTS,
      p_net_accounts: VAT_SETTLEMENT_NET_ACCOUNTS,
    })
    if (specialError) throw specialError
    const leftOut = new Set(
      ((special ?? []) as Array<{ journal_entry_id: string; reason: string }>)
        .filter((row) => LEFT_OUT_REASONS.has(row.reason))
        .map((row) => row.journal_entry_id),
    )
    const readByRutor = (entry: EntryRow) =>
      entry.source_type !== 'vat_settlement' &&
      !(entry.status === 'posted' && closingIds.has(entry.id)) &&
      !leftOut.has(entry.id)

    const redated = rattelseRows.filter((row) => row.rattelse_type === 'metadata')
    const lineIds = [
      ...late.filter(readByRutor).map((entry) => entry.id),
      ...redated.map((row) => row.journal_entry_id),
    ]
    const lines = await chunked([...new Set(lineIds)], async (chunk) =>
      fetchAllRows<LineRow>(({ from, to }) =>
        supabase
          .from('journal_entry_lines')
          .select('id, journal_entry_id, account_number, debit_amount, credit_amount')
          .in('journal_entry_id', chunk)
          .order('id')
          .range(from, to),
      ),
    )
    const linesOf = (entryId: string) => lines.filter((line) => line.journal_entry_id === entryId)

    const total: RutorChange = {}
    const verifikat: VatFilingChange['verifikat'] = []
    const record = (entry: EntryRow, changedAt: string, kind: 'posted' | 'rattelse' | 'redated', change: RutorChange) => {
      const nonZero = moved(change)
      if (Object.keys(nonZero).length === 0) return
      addInto(total, nonZero)
      verifikat.push({
        journal_entry_id: entry.id,
        voucher: formatVoucher(entry),
        entry_date: entry.entry_date,
        changed_at: changedAt,
        kind,
        rutor_change: nonZero,
      })
    }

    for (const entry of late) {
      if (readByRutor(entry)) record(entry, postedAt(entry), 'posted', linesChange(entry.id, linesOf(entry.id), accounts, deferrals))
    }
    for (const row of rattelseRows) {
      const entry = rattelseEntries.get(row.journal_entry_id) as EntryRow
      if (row.rattelse_type === 'lines') {
        if (!readByRutor(entry)) continue
        const change = linesChange(entry.id, row.added_lines, accounts, deferrals)
        addInto(change, linesChange(entry.id, row.struck_lines, accounts, deferrals), -1)
        record(entry, row.created_at, 'rattelse', change)
        continue
      }
      const movedIn = inPeriod(row.new_entry_date, filing)
      if (movedIn && !readByRutor(entry)) continue
      if (!movedIn) {
        // Moved out: the period's special entries no longer list it, so the
        // shape is judged on its own lines, as a staged voucher is.
        taxAccounts ??= await skattekontoShapeAccounts(supabase, companyId)
        const shaped = momsredovisningShapeOfLines(linesOf(entry.id), taxAccounts)
        if (entry.source_type === 'vat_settlement' || closingIds.has(entry.id) || shaped) continue
      }
      const change: RutorChange = {}
      addInto(change, linesChange(entry.id, linesOf(entry.id), accounts, deferrals), movedIn ? 1 : -1)
      record(entry, row.created_at, 'redated', change)
    }

    const change = moved(total)
    result.push({
      ...filing,
      changed_after_filing: Object.keys(change).length === 0
        ? null
        : {
            changed_after: baseline,
            rutor_change: change,
            verifikat: verifikat.sort((a, b) => instant(a.changed_at) - instant(b.changed_at)),
          },
    })
  }
  return result
}

/**
 * The company's filing records with what changed each period since it was
 * filed, for every door that lists filings (the VAT page, v1, MCP). The list
 * is what the VAT page opens its period from, so a failed change read does
 * not take it down: every record then answers null and the failure is logged.
 */
export async function listVatFilingsWithChanges(
  supabase: SupabaseClient,
  companyId: string,
): Promise<VatFilingRecordWithChange[]> {
  const filings = await listVatFilings(supabase, companyId)
  try {
    return await withChangesAfterFiling(supabase, companyId, filings)
  } catch (err) {
    log.error('changes after filing could not be read', err as Error, { companyId })
    return filings.map((filing) => ({ ...filing, changed_after_filing: null }))
  }
}

async function skattekontoShapeAccounts(supabase: SupabaseClient, companyId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc('skattekonto_shape_accounts', { p_company_id: companyId })
  if (error) throw error
  if (!Array.isArray(data) || !data.every((account) => typeof account === 'string')) {
    throw new Error('skattekonto_shape_accounts returned no account list')
  }
  return data
}
