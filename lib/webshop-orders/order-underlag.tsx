import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { fallbackVatBreakdown } from '@/lib/webshop-orders/booking-lines'
import type { Logger } from '@/lib/logger'
import type { WebshopOrder } from '@/types'

/**
 * Orderunderlag for a booked webshop order (issue #1881).
 *
 * The booking verifikat only carries the VAT split (buildOrderBookingLines),
 * so without this document the archived affärshändelse loses everything the
 * sync already knows: product lines, customer, payment method. BFL 5 kap 7 §
 * requires the verifikation to rest on underlag that shows what the
 * affärshändelse was; this module renders that underlag from the stored
 * webshop_orders row and archives it on the verifikat through the same WORM
 * document path the issued-invoice PDF uses (archiveIssuedInvoicePdf).
 *
 * Swedish-only on purpose: underlag is räkenskapsinformation, the same
 * stays-Swedish surface class as invoice PDFs and SIE exports.
 */

/** Everything the PDF renders, precomputed so it is testable without react-pdf. */
export interface OrderUnderlagModel {
  title: string
  isRefund: boolean
  orderNumber: string
  platformLabel: string
  storeLabel: string | null
  orderDate: string
  paidDate: string | null
  status: string
  /** Company/person lines shown under "Kund"; empty when the store sent none. */
  customerLines: string[]
  paymentMethod: string | null
  gatewayReference: string | null
  currency: string
  lines: Array<{
    name: string
    quantity: number
    /** Net (excl. VAT), in the order's currency, signed as stored. */
    net: number
    tax: number
    /** '25%' | '12%' | '6%' | '0%' | '-' (unresolved rate). */
    vatRateLabel: string
  }>
  /** Per-rate summary; signed like the row (negative on refunds). */
  vatRows: Array<{ rateLabel: string; net: number; tax: number; gross: number }>
  totalNet: number
  totalTax: number
  totalGross: number
  /** SEK conversion facts for non-SEK orders; null when SEK or unresolved. */
  totalSek: number | null
  exchangeRate: number | null
}

const PLATFORM_LABELS: Record<string, string> = {
  woocommerce: 'WooCommerce',
  shopify: 'Shopify',
}

function vatRateLabel(rate: number | null): string {
  if (rate === null) return '-'
  return `${rate}%`
}

/**
 * Build the render model from a stored order row. Pure; all money through
 * roundOre. Refund rows keep their negative signs so the underlag reads like
 * the money movement it documents.
 */
export function buildOrderUnderlagModel(
  order: Pick<
    WebshopOrder,
    | 'row_type'
    | 'platform'
    | 'store_label'
    | 'store_scope'
    | 'order_number'
    | 'status'
    | 'order_date'
    | 'paid_date'
    | 'currency'
    | 'total'
    | 'total_tax'
    | 'total_sek'
    | 'exchange_rate'
    | 'vat_breakdown'
    | 'line_items'
    | 'customer_name'
    | 'customer_company'
    | 'customer_email'
    | 'customer_country'
    | 'payment_method'
    | 'payment_method_title'
    | 'gateway_reference'
  >,
): OrderUnderlagModel {
  const isRefund = order.row_type === 'refund'
  const currency = order.currency.toUpperCase()
  const isSek = currency === 'SEK'

  const lines = (order.line_items ?? []).map((item) => ({
    name: item.name,
    quantity: item.quantity,
    net: roundOre(item.total),
    tax: roundOre(item.total_tax),
    vatRateLabel: vatRateLabel(item.vat_rate),
  }))

  // Refund rows store the breakdown as positive magnitudes (direction lives
  // in row_type, mirroring booking-lines); re-apply the sign so the summary
  // matches the negative totals. Order rows keep the buckets as stored:
  // they are SIGNED there (a discount bucket carries a negative net). Fall
  // back to the inferred single bucket exactly like the booking prefill when
  // the sync could not build one.
  const breakdown =
    order.vat_breakdown.length > 0
      ? order.vat_breakdown
      : fallbackVatBreakdown(order.total, order.total_tax)
  const vatRows = breakdown.map((bucket) => {
    const net = roundOre(isRefund ? -Math.abs(bucket.net) : bucket.net)
    const tax = roundOre(isRefund ? -Math.abs(bucket.tax) : bucket.tax)
    return {
      rateLabel: vatRateLabel(bucket.rate),
      net,
      tax,
      gross: roundOre(net + tax),
    }
  })

  const totalGross = roundOre(order.total)
  const totalTax = roundOre(order.total_tax)

  const customerLines = [
    order.customer_company,
    order.customer_name,
    order.customer_email,
    order.customer_country ? `Land: ${order.customer_country.toUpperCase()}` : null,
  ].filter((line): line is string => !!line)

  return {
    title: isRefund ? 'Orderunderlag: återbetalning' : 'Orderunderlag',
    isRefund,
    orderNumber: order.order_number,
    platformLabel: PLATFORM_LABELS[order.platform] ?? order.platform,
    storeLabel: order.store_label || order.store_scope || null,
    orderDate: order.order_date,
    paidDate: order.paid_date,
    status: order.status,
    customerLines,
    paymentMethod: order.payment_method_title || order.payment_method || null,
    gatewayReference: order.gateway_reference,
    currency,
    lines,
    vatRows,
    totalNet: roundOre(totalGross - totalTax),
    totalTax,
    totalGross,
    totalSek: isSek ? null : order.total_sek !== null ? roundOre(order.total_sek) : null,
    exchangeRate: isSek ? null : order.exchange_rate,
  }
}

/** Sanitized-enough name; uploadDocument sanitizes the storage key itself. */
export function orderUnderlagFilename(model: Pick<OrderUnderlagModel, 'isRefund' | 'orderNumber' | 'orderDate'>): string {
  const kind = model.isRefund ? 'Orderunderlag_aterbetalning' : 'Orderunderlag'
  return `${kind}_${model.orderNumber}_${model.orderDate}.pdf`
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingHorizontal: 40,
    paddingBottom: 60,
    fontSize: 9,
    fontFamily: 'Helvetica',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#d4d4d4',
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 10,
    color: '#333',
    marginBottom: 2,
  },
  meta: {
    fontSize: 9,
    color: '#666',
  },
  companyInfo: {
    textAlign: 'right',
  },
  companyName: {
    fontSize: 11,
    fontWeight: 'bold',
    marginBottom: 2,
  },
  block: {
    marginBottom: 12,
  },
  blockRow: {
    flexDirection: 'row',
    gap: 32,
    marginBottom: 14,
  },
  blockLabel: {
    fontSize: 7.5,
    fontWeight: 'bold',
    color: '#555',
    textTransform: 'uppercase',
    marginBottom: 3,
  },
  blockText: {
    fontSize: 9,
    color: '#1a1a1a',
    marginBottom: 1,
  },
  blockMuted: {
    fontSize: 9,
    color: '#888',
    fontStyle: 'italic',
  },
  sectionHeading: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginTop: 8,
    marginBottom: 5,
    paddingBottom: 3,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 0.8,
    borderBottomColor: '#999',
  },
  headerCell: {
    fontSize: 7.5,
    fontWeight: 'bold',
    color: '#555',
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 0.4,
    borderBottomColor: '#e4e4e4',
  },
  totalRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
  },
  colName: {
    flex: 1,
    paddingRight: 8,
    color: '#1a1a1a',
  },
  colQty: {
    width: 40,
    textAlign: 'right',
    fontFamily: 'Courier',
  },
  colAmount: {
    width: 70,
    textAlign: 'right',
    fontFamily: 'Courier',
    color: '#1a1a1a',
  },
  colRate: {
    width: 50,
    textAlign: 'right',
    color: '#666',
  },
  bold: {
    fontWeight: 'bold',
  },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 40,
    right: 40,
    borderTopWidth: 0.5,
    borderTopColor: '#d4d4d4',
    paddingTop: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerText: {
    fontSize: 8,
    color: '#888',
  },
})

// U+2212 MINUS SIGN, which sv-SE Intl emits for negatives. Standard PDF
// fonts (Helvetica/WinAnsi) have no glyph for it and drop it silently, so a
// refund would render as a POSITIVE amount in the archived underlag (skeptic
// finding; same guard as formatPdfCurrency in lib/invoices/pdf-template).
// Built via fromCharCode so no escape sequence can mangle in transit.
const UNICODE_MINUS = String.fromCharCode(0x2212)

/** Exported for tests: the sign guard must never regress. */
export function formatAmount(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .format(amount)
    .replaceAll(UNICODE_MINUS, '-')
}

export interface OrderUnderlagCompany {
  company_name?: string | null
  org_number?: string | null
}

export function WebshopOrderUnderlagPDF({
  model,
  company,
  generatedAt,
}: {
  model: OrderUnderlagModel
  company: OrderUnderlagCompany
  generatedAt: string
}) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View>
            <Text style={styles.title}>{model.title}</Text>
            <Text style={styles.subtitle}>
              Order {model.orderNumber}
              {model.storeLabel ? ` · ${model.storeLabel}` : ''} ({model.platformLabel})
            </Text>
            <Text style={styles.meta}>
              Orderdatum: {model.orderDate}
              {model.paidDate ? ` · Betald: ${model.paidDate}` : ''} · Status: {model.status}
            </Text>
          </View>
          <View style={styles.companyInfo}>
            {company.company_name ? (
              <Text style={styles.companyName}>{company.company_name}</Text>
            ) : null}
            {company.org_number ? (
              <Text style={styles.meta}>Org.nr: {company.org_number}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.blockRow}>
          <View style={styles.block}>
            <Text style={styles.blockLabel}>Kund</Text>
            {model.customerLines.length > 0 ? (
              model.customerLines.map((line, i) => (
                <Text key={i} style={styles.blockText}>
                  {line}
                </Text>
              ))
            ) : (
              <Text style={styles.blockMuted}>Uppgift saknas i ordern</Text>
            )}
          </View>
          <View style={styles.block}>
            <Text style={styles.blockLabel}>Betalning</Text>
            <Text style={styles.blockText}>{model.paymentMethod ?? 'Okänd betalmetod'}</Text>
            {model.gatewayReference ? (
              <Text style={styles.blockText}>Referens: {model.gatewayReference}</Text>
            ) : null}
            {model.totalSek !== null ? (
              <Text style={styles.blockText}>
                Motsvarande i SEK: {formatAmount(model.totalSek)} kr
                {model.exchangeRate ? ` (kurs ${model.exchangeRate})` : ''}
              </Text>
            ) : null}
          </View>
        </View>

        <Text style={styles.sectionHeading}>Orderrader ({model.currency})</Text>
        {model.lines.length === 0 ? (
          <Text style={styles.blockMuted}>Ordern saknar radspecifikation från butiken.</Text>
        ) : (
          <View>
            <View style={styles.tableHeader}>
              <Text style={[styles.colName, styles.headerCell]}>Beskrivning</Text>
              <Text style={[styles.colQty, styles.headerCell]}>Antal</Text>
              <Text style={[styles.colAmount, styles.headerCell]}>Exkl. moms</Text>
              <Text style={[styles.colAmount, styles.headerCell]}>Moms</Text>
              <Text style={[styles.colRate, styles.headerCell]}>Sats</Text>
            </View>
            {model.lines.map((line, i) => (
              <View key={i} style={styles.row} wrap={false}>
                <Text style={styles.colName}>{line.name}</Text>
                <Text style={styles.colQty}>{line.quantity}</Text>
                <Text style={styles.colAmount}>{formatAmount(line.net)}</Text>
                <Text style={styles.colAmount}>{formatAmount(line.tax)}</Text>
                <Text style={styles.colRate}>{line.vatRateLabel}</Text>
              </View>
            ))}
          </View>
        )}

        <Text style={styles.sectionHeading}>Belopp per momssats ({model.currency})</Text>
        <View>
          <View style={styles.tableHeader}>
            <Text style={[styles.colName, styles.headerCell]}>Momssats</Text>
            <Text style={[styles.colAmount, styles.headerCell]}>Netto</Text>
            <Text style={[styles.colAmount, styles.headerCell]}>Moms</Text>
            <Text style={[styles.colAmount, styles.headerCell]}>Summa</Text>
          </View>
          {model.vatRows.map((row, i) => (
            <View key={i} style={styles.row} wrap={false}>
              <Text style={styles.colName}>{row.rateLabel}</Text>
              <Text style={styles.colAmount}>{formatAmount(row.net)}</Text>
              <Text style={styles.colAmount}>{formatAmount(row.tax)}</Text>
              <Text style={styles.colAmount}>{formatAmount(row.gross)}</Text>
            </View>
          ))}
          <View style={styles.totalRow}>
            <Text style={[styles.colName, styles.bold]}>Totalt</Text>
            <Text style={[styles.colAmount, styles.bold]}>{formatAmount(model.totalNet)}</Text>
            <Text style={[styles.colAmount, styles.bold]}>{formatAmount(model.totalTax)}</Text>
            <Text style={[styles.colAmount, styles.bold]}>{formatAmount(model.totalGross)}</Text>
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Underlag genererat ur butikens orderdata vid bokföring
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) =>
              `Genererad ${generatedAt} · Sida ${pageNumber} av ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  )
}

export interface ArchiveOrderUnderlagResult {
  ok: boolean
  documentId: string | null
}

/**
 * Render the orderunderlag and archive it on the just-committed verifikat.
 * Mirrors archiveIssuedInvoicePdf: never throws, the booking is already
 * committed and immutable, so a failure here is logged and surfaced to the
 * caller as ok=false. The verifikat then stays on the "saknar underlag"
 * worklist (webshop_order is a needs-doc source type), which is exactly the
 * recovery mechanism: the user attaches an underlag by hand.
 */
export async function archiveWebshopOrderUnderlag(args: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  order: WebshopOrder
  journalEntryId: string
  log: Logger
}): Promise<ArchiveOrderUnderlagResult> {
  const { supabase, companyId, userId, order, journalEntryId, log } = args
  try {
    const model = buildOrderUnderlagModel(order)

    // Header context only; the underlag is valid without it.
    let company: OrderUnderlagCompany = {}
    try {
      const { data } = await supabase
        .from('company_settings')
        .select('company_name, org_number')
        .eq('company_id', companyId)
        .maybeSingle()
      company = (data as OrderUnderlagCompany | null) ?? {}
    } catch {
      company = {}
    }

    const pdfBuffer = await renderToBuffer(
      WebshopOrderUnderlagPDF({
        model,
        company,
        generatedAt: new Date().toISOString().split('T')[0],
      }),
    )
    const pdfArrayBuffer = new Uint8Array(pdfBuffer).buffer as ArrayBuffer

    const document = await uploadDocument(
      supabase,
      userId,
      companyId,
      {
        name: orderUnderlagFilename(model),
        buffer: pdfArrayBuffer,
        type: 'application/pdf',
      },
      {
        upload_source: 'system',
        journal_entry_id: journalEntryId,
        // Self-generated from structured data: nothing to extract.
        extractionOwner: 'none',
      },
    )
    return { ok: true, documentId: document.id }
  } catch (err) {
    log.error('failed to archive webshop order underlag', err as Error, {
      orderId: order.id,
      journalEntryId,
    })
    return { ok: false, documentId: null }
  }
}
