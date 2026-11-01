import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import type { SupabaseClient } from '@supabase/supabase-js'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { roundOre } from '@/lib/money'
import { formatAmount, formatOrgNumber } from '@/lib/utils'
import { pdfText } from '@/lib/pdf/number-text'

/**
 * The payment record of a payment the collections provider collected
 * (build spec 4.2 C): the underlag of the C voucher.
 *
 * The C voucher (Dr clearing / Cr 1510, or revenue and VAT under
 * kontantmetoden) rests on no document the company received: the debtor paid
 * the provider, and the provider's payout specification only comes later and
 * covers many payments. BFL 5 kap 6 and 7 §§ want the verifikation to show
 * what happened, so the ledger writes it down from the provider's own payment
 * list when it books: which invoice and case, what the debtor paid and how it
 * was split, on which day, the provider's payment reference, and when and by
 * whom it was booked. The PDF is archived WORM through the document service
 * BEFORE the voucher (collected-payments.ts), so no C voucher exists without
 * an underlag to link; the settlement PDF is linked to the same voucher later
 * as a copy (settlements.ts).
 *
 * Swedish only on purpose: underlag is räkenskapsinformation, the same
 * stays-Swedish surface as invoice PDFs and SIE files. The provider's name
 * comes from the connection at runtime, never from code.
 */

export interface PaymentRecordModel {
  providerName: string
  companyName: string | null
  orgNumber: string | null
  invoiceNumber: string | null
  customerName: string | null
  caseNumber: string | null
  providerPaymentRef: string
  paidAt: string
  currency: string
  total: number | null
  capitalPaid: number
  toCreditorOther: number
  toAgency: number
  clearingAccount: string
  /** When the booking ran, Swedish time, "YYYY-MM-DD HH:MM". */
  bookedAt: string
  /** The person who booked, or for whom the automatic booking ran. */
  bookedBy: string
  automatic: boolean
  /** A rebook: the earlier voucher of this payment and its storno ("C12, stornerad genom C13"). */
  replaces: string | null
}

export interface PaymentRecordInput {
  providerName: string | null
  company: { company_name?: string | null; org_number?: string | null } | null
  invoice: { invoice_number?: string | null; customer_name?: string | null }
  caseNumber: string | null
  payment: {
    provider_payment_ref: string
    paid_at: string
    total: number | null
    capital_paid: number
    to_creditor_other: number
    to_agency: number
  }
  currency: string
  clearingAccount: string
  bookedAt: Date
  bookedBy: string
  automatic: boolean
  replaces?: string | null
}

/** "YYYY-MM-DD HH:MM" in Swedish time. */
export function formatStockholmTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

/** Pure: everything the PDF shows, money through roundOre. */
export function buildPaymentRecordModel(input: PaymentRecordInput): PaymentRecordModel {
  return {
    providerName: input.providerName?.trim() || 'inkassobolaget',
    companyName: input.company?.company_name ?? null,
    orgNumber: input.company?.org_number?.trim() ? formatOrgNumber(input.company.org_number.trim()) : null,
    invoiceNumber: input.invoice.invoice_number ?? null,
    customerName: input.invoice.customer_name ?? null,
    caseNumber: input.caseNumber,
    providerPaymentRef: input.payment.provider_payment_ref,
    paidAt: input.payment.paid_at,
    currency: input.currency,
    total: input.payment.total === null ? null : roundOre(input.payment.total),
    capitalPaid: roundOre(input.payment.capital_paid),
    toCreditorOther: roundOre(input.payment.to_creditor_other),
    toAgency: roundOre(input.payment.to_agency),
    clearingAccount: input.clearingAccount,
    bookedAt: formatStockholmTime(input.bookedAt),
    bookedBy: input.bookedBy,
    automatic: input.automatic,
    replaces: input.replaces?.trim() || null,
  }
}

export function paymentRecordFilename(model: Pick<PaymentRecordModel, 'invoiceNumber' | 'paidAt' | 'providerPaymentRef'>): string {
  const ref = model.providerPaymentRef.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'betalning'
  const invoice = (model.invoiceNumber ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  return `Inbetalning_inkasso${invoice ? `_${invoice}` : ''}_${model.paidAt}_${ref}.pdf`
}

export function formatRecordAmount(amount: number): string {
  return pdfText(formatAmount(amount))
}

/** The rows of the record, in order, as label and value. Pure, so the content is testable without react-pdf. */
export function paymentRecordRows(model: PaymentRecordModel): Array<{ label: string; value: string }> {
  const money = (amount: number) => `${formatRecordAmount(amount)} ${model.currency}`
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Faktura', value: model.invoiceNumber ?? 'Uppgift saknas' },
    ...(model.customerName ? [{ label: 'Kund', value: model.customerName }] : []),
    { label: `Ärende hos ${model.providerName}`, value: model.caseNumber ?? 'Uppgift saknas' },
    { label: `Kunden betalade till ${model.providerName}`, value: model.paidAt },
    { label: `Betalningsreferens hos ${model.providerName}`, value: model.providerPaymentRef },
  ]
  if (model.total !== null) rows.push({ label: 'Kunden betalade totalt', value: money(model.total) })
  rows.push({ label: 'Varav kapital, minskar kundfordran', value: money(model.capitalPaid) })
  if (model.toCreditorOther !== 0) rows.push({ label: 'Varav övrigt till företaget', value: money(model.toCreditorOther) })
  if (model.toAgency !== 0) rows.push({ label: `Varav avgifter och ränta som ${model.providerName} behåller`, value: money(model.toAgency) })
  rows.push({ label: 'Bokförs mot konto', value: `${model.clearingAccount} (inkasserat, ännu inte utbetalt)` })
  // A rebook: the new voucher's underlag names the voucher it replaces (BFL 5 kap 5 §, the rättelse can be followed both ways).
  if (model.replaces) rows.push({ label: 'Ersätter verifikation', value: model.replaces })
  rows.push({ label: 'Bokförd', value: model.bookedAt })
  rows.push({ label: 'Bokförd av', value: model.automatic ? `Automatisk bokföring för ${model.bookedBy}` : model.bookedBy })
  return rows
}

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingHorizontal: 40, paddingBottom: 60, fontSize: 10, fontFamily: 'Helvetica' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#d4d4d4',
  },
  title: { fontSize: 18, fontWeight: 'bold', color: '#1a1a1a', marginBottom: 4 },
  meta: { fontSize: 9, color: '#555' },
  companyInfo: { alignItems: 'flex-end' },
  companyName: { fontSize: 11, fontWeight: 'bold', marginBottom: 2 },
  row: { flexDirection: 'row', paddingVertical: 5, borderBottomWidth: 0.5, borderBottomColor: '#e5e5e5' },
  label: { width: '50%', color: '#555' },
  value: { width: '50%' },
  note: { marginTop: 18, fontSize: 9, color: '#555', lineHeight: 1.4 },
  footer: { position: 'absolute', bottom: 30, left: 40, right: 40, fontSize: 8, color: '#888' },
})

export function PaymentRecordPDF({ model }: { model: PaymentRecordModel }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Inbetalning via {model.providerName}</Text>
            <Text style={styles.meta}>Betalningsunderlag för en inbetalning som inkassobolaget tagit emot</Text>
          </View>
          <View style={styles.companyInfo}>
            {model.companyName ? <Text style={styles.companyName}>{model.companyName}</Text> : null}
            {model.orgNumber ? <Text style={styles.meta}>Org.nr: {model.orgNumber}</Text> : null}
          </View>
        </View>
        {paymentRecordRows(model).map((row, i) => (
          <View key={i} style={styles.row} wrap={false}>
            <Text style={styles.label}>{row.label}</Text>
            <Text style={styles.value}>{row.value}</Text>
          </View>
        ))}
        <Text style={styles.note}>
          Kunden har betalat till {model.providerName}, som tar emot betalningen för företagets räkning. Kapitalet bokförs som
          betalning av fakturan den dag kunden betalade, mot konto {model.clearingAccount}. Utbetalningen till företaget
          redovisas i avräkningen från {model.providerName}, som bifogas samma verifikation när den bokförs.
        </Text>
        <Text style={styles.footer}>Underlaget är upprättat ur {model.providerName}s betalningsuppgifter när betalningen bokfördes.</Text>
      </Page>
    </Document>
  )
}

/** Render the record and archive it WORM (not yet linked to a voucher). Answers the document id. */
export async function archivePaymentRecord(
  db: SupabaseClient,
  input: { companyId: string; userId: string; model: PaymentRecordModel },
): Promise<string> {
  const pdf = await renderToBuffer(PaymentRecordPDF({ model: input.model }))
  const buffer = new Uint8Array(pdf).buffer as ArrayBuffer
  const document = await uploadDocument(
    db,
    input.userId,
    input.companyId,
    { name: paymentRecordFilename(input.model), buffer, type: 'application/pdf' },
    // Generated from structured data: nothing to extract.
    { upload_source: 'system', extractionOwner: 'none' },
  )
  return document.id
}
