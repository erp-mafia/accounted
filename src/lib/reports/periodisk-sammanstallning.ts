import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import {
  INVOICE_SOURCED_ENTRY_TYPES,
  LINK_LOOKUP_CHUNK,
  getInvoicesExplainingJournalEntries,
} from '@/lib/core/bookkeeping/journal-entry-references'
import { calculatePeriodDates, formatPeriodLabel } from './period-dates'
import { calculateVatDeclaration } from './vat-declaration'
import { normalizeCountryCode } from '@/lib/vat/country-codes'

/**
 * Periodisk sammanställning (EC Sales List / SKV 5740).
 *
 * Pure projection from the general ledger: posted journal entry lines on the
 * three EU revenue accounts (3308 services, 3108 goods, 3107 triangulation)
 * are joined back to the originating invoice and customer to produce one row
 * per (country, vat_number) with three amount buckets.
 *
 * Shares its source data with vat-declaration.ts so the PS totals and the
 * momsdeklaration Ruta 35/38/39 can never drift. See §1.2 of the plan.
 *
 * Notes:
 *   - Which invoice a posting belongs to is resolved through every link the
 *     register keeps (the engine's source_id, invoices.journal_entry_id,
 *     invoice_payments.journal_entry_id), so a SIE-imported sale matched to
 *     its invoice afterwards and a kontantmetod inbetalning are filed too
 *     (#2298). A storno or rättelse of such a posting is filed under the
 *     same invoice by following reverses_id / correction_of_id (#2351), so a
 *     makulerad sale nets to zero here exactly as it does in ruta 39. A
 *     3308/3108 posting no invoice points at is not filed (there is no
 *     customer to name); the momsdeklaration reconciliation (ruta 35/38/39)
 *     is where such a gap shows.
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

export interface PsWarning {
  level: 'error' | 'warning'
  code: PsWarningCode
  message: string
  customerId?: string
  customerName?: string
  invoiceId?: string
  /** The verifikat a MIXED_CUSTOMER_SETTLEMENT warning is about. */
  journalEntryId?: string
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

const ACCOUNT_TO_BUCKET: Record<string, 'services' | 'goods' | 'triangulation'> = {
  '3308': 'services',
  '3108': 'goods',
  '3107': 'triangulation',
}

const PS_ACCOUNTS = Object.keys(ACCOUNT_TO_BUCKET)

interface RawEntryLine {
  account_number: string
  debit_amount: number | string
  credit_amount: number | string
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
  return entry.voucher_number != null
    ? `${entry.voucher_series ?? ''}${entry.voucher_number}`
    : entry.id
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

  // Driven from journal_entries (company + date indexed) with the EU-revenue
  // condition as an inner embed: the planner probes journal_entry_lines per
  // entry, so only entries carrying a posting on a PS account come back, with
  // just those lines. Never the inverse shape (lines with an entries embed):
  // see lib/bookkeeping/entry-lines.ts. No source_type filter: which register
  // invoice a posting belongs to is resolved below through every link the
  // register keeps, not only the engine's own source columns.
  const entries = await fetchAllRows<RawEntry>(({ from, to }) =>
    supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number, entry_date, status, source_type, source_id, reverses_id, correction_of_id, journal_entry_lines!inner(account_number, debit_amount, credit_amount)')
      .eq('company_id', companyId)
      .in('status', ['posted', 'reversed'])
      .gte('entry_date', start)
      .lte('entry_date', end)
      .in('journal_entry_lines.account_number', PS_ACCOUNTS)
      // Stable total order for correct paging (see fetch-all.ts).
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: RawEntry[] | null; error: { message: string } | null }>,
  )

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
  // several invoices. All of them are loaded so the loop below can tell "two
  // invoices, one customer" from "two customers on one posting".
  const invoiceIdsByEntry = await getInvoicesExplainingJournalEntries(supabase, companyId, entries)

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

  for (const line of lines) {
    const bucket = ACCOUNT_TO_BUCKET[line.account_number]
    if (!bucket) continue
    const invoiceIds = invoiceIdsByEntry.get(line.entry.id)
    // A manual or imported posting no register invoice points at is not
    // filed (see the header). The engine's own entries never take this exit:
    // an engine entry whose invoice is gone is a data defect and falls
    // through to CUSTOMER_NOT_FOUND below.
    if (!invoiceIds && !INVOICE_SOURCED_ENTRY_TYPES.has(line.entry.source_type ?? '')) continue
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
 * Cross-check PS totals against momsdeklaration Ruta 35/38/39.
 *
 * Only meaningful when the PS period coincides with the momsdeklaration period.
 * Returns the report with reconciliation populated; matches=null indicates the
 * caller asked for a check that doesn't make sense (different periods).
 */
export async function reconcilePsAgainstVatDeclaration(
  supabase: SupabaseClient,
  companyId: string,
  report: PeriodiskSammanstallningReport,
  momsPeriod: 'monthly' | 'quarterly' | 'yearly' | null,
): Promise<PeriodiskSammanstallningReport> {
  // Reconciliation only valid when periods coincide. Yearly is never valid for PS.
  const periodsCoincide =
    (report.period.type === 'monthly' && momsPeriod === 'monthly') ||
    (report.period.type === 'quarterly' && momsPeriod === 'quarterly')

  if (!periodsCoincide) {
    return report
  }

  const vat = await calculateVatDeclaration(
    supabase,
    companyId,
    report.period.type,
    report.period.year,
    report.period.period,
  )

  const ruta35 = Math.round(vat.rutor.ruta35)
  const ruta38 = Math.round(vat.rutor.ruta38 ?? 0)
  const ruta39 = Math.round(vat.rutor.ruta39)

  const tolerance = report.reconciliation.tolerance
  const matches =
    Math.abs(report.totals.services - ruta39) <= tolerance &&
    Math.abs(report.totals.goods - ruta35) <= tolerance &&
    Math.abs(report.totals.triangulation - ruta38) <= tolerance

  return {
    ...report,
    reconciliation: {
      ruta39,
      ruta35,
      ruta38,
      matches,
      tolerance,
    },
  }
}

export { formatPeriodLabel } from './period-dates'
