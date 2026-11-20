import { Document, Page, Text, View, renderToBuffer } from '@react-pdf/renderer'
import { isLedgerCurrency, sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput, WebshopOrder } from '@/types'
import { formatAmount, styles, type OrderUnderlagCompany } from './order-underlag'

/**
 * Dagssammanställning: the underlag of a day booking (book-day.ts), one
 * verifikat for a store's orders and refunds of one day and payment method.
 *
 * BFL 5 kap 6 § lets likartade affärshändelser share a gemensam verifikation,
 * and BFNAR 2013:2 p. 6.1 counts similar affärshändelser on the same day
 * among them. The verifikat itself only carries the summed lines, so this
 * document lists every order it covers (number, date, country, amount, VAT)
 * to keep each one traceable to the store's own order; the order rows stay
 * linked to the verifikat (webshop_orders.journal_entry_id) as well.
 *
 * Swedish-only on purpose: underlag is räkenskapsinformation, like the
 * orderunderlag (order-underlag.tsx).
 */

export interface DayUnderlagModel {
  platformLabel: string
  storeLabel: string
  date: string
  paymentMethod: string
  rows: Array<{
    orderNumber: string
    kind: 'Order' | 'Återbetalning'
    paidDate: string
    country: string
    currency: string
    /** In the order's currency, signed (negative on refunds). */
    total: number
    /** In SEK as booked, signed. */
    totalSek: number
    vatSek: number
  }>
  orderCount: number
  refundCount: number
  totalSek: number
  vatSek: number
  lines: Array<{ account: string; debit: number; credit: number }>
  totalDebit: number
  totalCredit: number
  voucherLabel: string | null
}

const PLATFORM_LABELS: Record<string, string> = {
  woocommerce: 'WooCommerce',
  shopify: 'Shopify',
  zettle: 'Zettle',
}

type DayOrder = Pick<
  WebshopOrder,
  | 'row_type'
  | 'order_number'
  | 'paid_date'
  | 'order_date'
  | 'customer_country'
  | 'currency'
  | 'total'
  | 'total_tax'
  | 'total_sek'
  | 'exchange_rate'
>

/** The order's amount in SEK as its lines book it (FX already resolved). */
function sekOf(order: DayOrder, amount: number): number {
  if (isLedgerCurrency(order.currency.toUpperCase())) return roundOre(amount)
  return sekOfForeign(amount, order.exchange_rate ?? 0)
}

/** Build the render model. Pure; all money through roundOre. */
export function buildDayUnderlagModel(args: {
  platform: string
  storeLabel: string
  date: string
  paymentMethod: string
  orders: DayOrder[]
  lines: CreateJournalEntryLineInput[]
  voucherLabel: string | null
}): DayUnderlagModel {
  const rows = args.orders.map((order) => {
    const isSek = isLedgerCurrency(order.currency.toUpperCase())
    return {
      orderNumber: order.order_number,
      kind: order.row_type === 'refund' ? ('Återbetalning' as const) : ('Order' as const),
      paidDate: order.paid_date ?? order.order_date,
      country: order.customer_country?.toUpperCase() ?? '-',
      currency: order.currency.toUpperCase(),
      total: roundOre(order.total),
      totalSek: isSek ? roundOre(order.total) : roundOre(order.total_sek ?? 0),
      vatSek: sekOf(order, order.total_tax),
    }
  })
  let totalSek = 0
  let vatSek = 0
  for (const row of rows) {
    totalSek = roundOre(totalSek + row.totalSek)
    vatSek = roundOre(vatSek + row.vatSek)
  }
  let totalDebit = 0
  let totalCredit = 0
  const lines = args.lines.map((line) => {
    totalDebit = roundOre(totalDebit + (line.debit_amount || 0))
    totalCredit = roundOre(totalCredit + (line.credit_amount || 0))
    return { account: line.account_number, debit: line.debit_amount || 0, credit: line.credit_amount || 0 }
  })
  return {
    platformLabel: PLATFORM_LABELS[args.platform] ?? args.platform,
    storeLabel: args.storeLabel,
    date: args.date,
    paymentMethod: args.paymentMethod,
    rows,
    orderCount: rows.filter((r) => r.kind === 'Order').length,
    refundCount: rows.filter((r) => r.kind === 'Återbetalning').length,
    totalSek,
    vatSek,
    lines,
    totalDebit,
    totalCredit,
    voucherLabel: args.voucherLabel,
  }
}

/** Every day summary file name starts with this. */
export const DAY_UNDERLAG_FILENAME_PREFIX = 'Dagssammanstallning'

export function dayUnderlagFilename(model: Pick<DayUnderlagModel, 'platformLabel' | 'date' | 'paymentMethod'>): string {
  return `${DAY_UNDERLAG_FILENAME_PREFIX}_${model.platformLabel}_${model.date}_${model.paymentMethod}.pdf`
}

const col = {
  number: { width: 70 },
  kind: { width: 72 },
  date: { width: 62 },
  country: { width: 36 },
  amount: { width: 72, textAlign: 'right' as const, fontFamily: 'Courier' },
}

export function WebshopDayUnderlagPDF({
  model,
  company,
  generatedAt,
}: {
  model: DayUnderlagModel
  company: OrderUnderlagCompany
  generatedAt: string
}) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View>
            <Text style={styles.title}>Dagssammanställning</Text>
            <Text style={styles.subtitle}>
              {model.storeLabel} ({model.platformLabel}) · {model.date}
            </Text>
            <Text style={styles.meta}>
              Betalsätt: {model.paymentMethod} · {model.orderCount} ordrar, {model.refundCount} återbetalningar
              {model.voucherLabel ? ` · Verifikat ${model.voucherLabel}` : ''}
            </Text>
          </View>
          <View style={styles.companyInfo}>
            {company.company_name ? <Text style={styles.companyName}>{company.company_name}</Text> : null}
            {company.org_number ? <Text style={styles.meta}>Org.nr: {company.org_number}</Text> : null}
          </View>
        </View>

        <Text style={styles.sectionHeading}>Ordrar och återbetalningar</Text>
        <View>
          <View style={styles.tableHeader} fixed>
            <Text style={[col.number, styles.headerCell]}>Order</Text>
            <Text style={[col.kind, styles.headerCell]}>Typ</Text>
            <Text style={[col.date, styles.headerCell]}>Datum</Text>
            <Text style={[col.country, styles.headerCell]}>Land</Text>
            <Text style={[styles.colName, styles.headerCell, { textAlign: 'right' }]}>Belopp</Text>
            <Text style={[col.amount, styles.headerCell]}>SEK</Text>
            <Text style={[col.amount, styles.headerCell]}>Moms SEK</Text>
          </View>
          {model.rows.map((row, i) => (
            <View key={i} style={styles.row} wrap={false}>
              <Text style={col.number}>{row.orderNumber}</Text>
              <Text style={col.kind}>{row.kind}</Text>
              <Text style={col.date}>{row.paidDate}</Text>
              <Text style={col.country}>{row.country}</Text>
              <Text style={[styles.colName, { textAlign: 'right', fontFamily: 'Courier' }]}>
                {isLedgerCurrency(row.currency) ? '' : `${formatAmount(row.total)} ${row.currency}`}
              </Text>
              <Text style={col.amount}>{formatAmount(row.totalSek)}</Text>
              <Text style={col.amount}>{formatAmount(row.vatSek)}</Text>
            </View>
          ))}
          <View style={styles.totalRow}>
            <Text style={[styles.colName, styles.bold]}>Totalt</Text>
            <Text style={[col.amount, styles.bold]}>{formatAmount(model.totalSek)}</Text>
            <Text style={[col.amount, styles.bold]}>{formatAmount(model.vatSek)}</Text>
          </View>
        </View>

        <Text style={styles.sectionHeading}>Kontering (SEK)</Text>
        <View>
          <View style={styles.tableHeader}>
            <Text style={[styles.colName, styles.headerCell]}>Konto</Text>
            <Text style={[styles.colAmount, styles.headerCell]}>Debet</Text>
            <Text style={[styles.colAmount, styles.headerCell]}>Kredit</Text>
          </View>
          {model.lines.map((line, i) => (
            <View key={i} style={styles.row} wrap={false}>
              <Text style={styles.colName}>{line.account}</Text>
              <Text style={styles.colAmount}>{line.debit ? formatAmount(line.debit) : ''}</Text>
              <Text style={styles.colAmount}>{line.credit ? formatAmount(line.credit) : ''}</Text>
            </View>
          ))}
          <View style={styles.totalRow}>
            <Text style={[styles.colName, styles.bold]}>Summa</Text>
            <Text style={[styles.colAmount, styles.bold]}>{formatAmount(model.totalDebit)}</Text>
            <Text style={[styles.colAmount, styles.bold]}>{formatAmount(model.totalCredit)}</Text>
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>Underlag genererat ur butikens orderdata vid bokföring</Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `Genererad ${generatedAt} · Sida ${pageNumber} av ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  )
}

export async function renderWebshopDayUnderlagPdf(args: {
  model: DayUnderlagModel
  company: OrderUnderlagCompany
  generatedAt: string
}): Promise<{ bytes: Uint8Array<ArrayBuffer>; filename: string }> {
  const buffer = await renderToBuffer(WebshopDayUnderlagPDF(args))
  return { bytes: new Uint8Array(buffer), filename: dayUnderlagFilename(args.model) }
}
