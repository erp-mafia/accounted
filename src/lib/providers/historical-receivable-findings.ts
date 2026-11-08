import { ISO_DATE_RE } from '@/lib/invariants/iso-date'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import type { SalesInvoiceDto } from './dto'

export interface HistoricalPaymentEntry {
  id: string
  date: string
  description: string
  series: string | null
  number: number | null
  receivableCredit: number
  bankDebit: number
}
export interface HistoricalInvoiceSource {
  chunkId: string
  sourceId: string
  payloadHash: string
  invoice: SalesInvoiceDto
  imported: boolean
  reviewable: boolean
}
export interface HistoricalReceivableFinding {
  paymentEntryId: string
  invoiceNumber: string
  customer: string
  paymentDate: string
  paymentAmount: number
  description: string
  voucher: string
  invoiceDate: string | null
  sourceId: string | null
  chunkId: string | null
  payloadHash: string | null
  origin: 'incomplete_invoice' | 'voucher_only'
}

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('sv-SE')
/** These are candidate descriptions, never authority to create a ledger entry. */
export function parseHistoricalPaymentDescription(text: string): { number: string; customer: string } | null {
  const bokio = /^faktura\s*#?\s*([0-9]{1,32})\s+betal(?:ad|d)\s+av\s+(.+?)\s*$/i.exec(text.trim())
  if (bokio) return { number: bokio[1], customer: bokio[2].trim() }
  const fortnox = /^kundbet(?:alning)?\s+(.+?)\s+\(([0-9]{1,32})\)\s*$/i.exec(text.trim())
  return fortnox ? { number: fortnox[2], customer: fortnox[1].trim() } : null
}

export function findHistoricalReceivableCandidates(
  entries: readonly HistoricalPaymentEntry[], sources: readonly HistoricalInvoiceSource[],
  existingInvoiceNumbers: ReadonlySet<string>,
): HistoricalReceivableFinding[] {
  const findings: HistoricalReceivableFinding[] = []
  for (const entry of entries) {
    const ref = parseHistoricalPaymentDescription(entry.description)
    if (!ref || !ref.customer || !ISO_DATE_RE.test(entry.date) || existingInvoiceNumbers.has(ref.number)) continue
    const amount = roundOre(entry.receivableCredit)
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(entry.bankDebit)
      || Math.abs(amount - roundOre(entry.bankDebit)) > ORE_TOLERANCE) continue
    const matching = sources.filter(source => source.invoice.invoiceNumber?.trim() === ref.number)
    if (matching.length > 1) continue
    const source = matching[0]
    if (!source) continue
    const dto = source.invoice
    // A normal invoice, credit, unsettled claim or explicit booking reference
    // must never be silently downgraded to historical payment-only metadata.
    if (source.imported || !source.reviewable || dto.lines.length || !dto.paymentStatus.paid || dto.status !== 'paid'
      || dto.invoiceTypeCode || dto.currencyCode !== 'SEK' || dto._raw?.journalEntryRef
      || normalize(dto.customer.name) !== normalize(ref.customer) || !ISO_DATE_RE.test(dto.issueDate) || dto.issueDate > entry.date
      || !Number.isFinite(dto.paymentStatus.balance.value) || !Number.isFinite(dto.legalMonetaryTotal.payableAmount.value)
      || Math.abs(dto.paymentStatus.balance.value) > ORE_TOLERANCE
      || Math.abs(dto.legalMonetaryTotal.payableAmount.value - amount) > ORE_TOLERANCE) continue
    findings.push({ paymentEntryId: entry.id, invoiceNumber: ref.number, customer: ref.customer,
      paymentDate: entry.date, paymentAmount: amount, description: entry.description,
      voucher: entry.series && entry.number !== null ? `${entry.series}${entry.number}` : '',
      invoiceDate: source.invoice.issueDate, sourceId: source.sourceId,
      chunkId: source.chunkId, payloadHash: source.payloadHash,
      origin: 'incomplete_invoice' })
  }
  return findings.sort((a, b) => historicalFindingCursor(a) < historicalFindingCursor(b) ? -1
    : historicalFindingCursor(a) > historicalFindingCursor(b) ? 1 : 0)
}

/** Include the payment date so pagination remains valid when a reviewed row disappears. */
export function historicalFindingCursor(row: Pick<HistoricalReceivableFinding, 'paymentDate' | 'paymentEntryId'>): string {
  return `${row.paymentDate}|${row.paymentEntryId}`
}

export function pageHistoricalReceivableFindings(findings: readonly HistoricalReceivableFinding[], after?: string) {
  const remaining = after ? findings.filter(row => historicalFindingCursor(row) > after) : findings
  return { findings: remaining.slice(0, 20), next: remaining.length > 20 ? historicalFindingCursor(remaining[19]) : null }
}
