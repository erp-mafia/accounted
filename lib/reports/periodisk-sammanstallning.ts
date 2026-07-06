import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { calculatePeriodDates, formatPeriodLabel } from './period-dates'
import { calculateVatDeclaration } from './vat-declaration'

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

export interface PsWarning {
  level: 'error' | 'warning'
  code: PsWarningCode
  message: string
  customerId?: string
  customerName?: string
  invoiceId?: string
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

interface RawLine {
  account_number: string
  debit_amount: number | string
  credit_amount: number | string
  journal_entries: {
    company_id: string
    entry_date: string
    status: string
    source_type: string
    source_id: string | null
  } | null
}

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

  const lines = await fetchAllRows<RawLine>(({ from, to }) =>
    supabase
      .from('journal_entry_lines')
      .select(`
        account_number,
        debit_amount,
        credit_amount,
        journal_entries!inner (
          company_id, entry_date, status, source_type, source_id
        )
      `)
      .in('account_number', PS_ACCOUNTS)
      .eq('journal_entries.company_id', companyId)
      .in('journal_entries.status', ['posted', 'reversed'])
      // Cash sales on 3308/3108 are not a real flow (EU reverse-charge sales
      // always go through AR); excluded to avoid phantom rows.
      .in('journal_entries.source_type', ['invoice_created', 'credit_note'])
      .gte('journal_entries.entry_date', start)
      .lte('journal_entries.entry_date', end)
      // Stable total order for correct paging (see fetch-all.ts).
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: RawLine[] | null; error: { message: string } | null }>,
  )

  const invoiceIds = Array.from(
    new Set(
      lines
        .map(l => l.journal_entries?.source_id)
        .filter((id): id is string => typeof id === 'string'),
    ),
  )

  const invoiceMap = new Map<string, RawInvoice>()
  if (invoiceIds.length > 0) {
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
        .in('id', invoiceIds)
        // Stable total order for correct paging (see fetch-all.ts).
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: RawInvoice[] | null; error: { message: string } | null }>,
    )
    for (const inv of invoices) invoiceMap.set(inv.id, inv)
  }

  const accumulators = new Map<string, Accumulator>()
  const warnings: PsWarning[] = []
  let goodsLineSeen = false

  for (const line of lines) {
    const je = line.journal_entries
    if (!je) continue
    const sourceId = je.source_id
    const invoice = sourceId ? invoiceMap.get(sourceId) : null
    const bucket = ACCOUNT_TO_BUCKET[line.account_number]
    if (!bucket) continue
    if (bucket === 'goods' || bucket === 'triangulation') goodsLineSeen = true

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

    const isoCountry = (customer.country ?? '').trim().toUpperCase()
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
            '(kreditfaktura tar ut original). Exkluderad från filen.',
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
