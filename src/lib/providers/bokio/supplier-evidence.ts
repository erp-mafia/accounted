import type { SupplierInvoiceDto, SupplierInvoiceEvidenceDto } from '../dto'
import type { BokioVoucherEvidence } from './attachments'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { roundOre } from '@/lib/money'

const same = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.round(a * 100) === Math.round(b * 100)

/**
 * The voucher describes the booking, not necessarily the supplier's invoice VAT.
 * Only a source net that independently corroborates ordinary invoiced VAT can
 * establish that split. Reverse charge, restricted deduction and unknown line
 * allocations stay unresolved. Never synthesize invoice rows from journal lines.
 */
export function enrichBokioSupplierInvoice(dto: SupplierInvoiceDto, entry?: BokioVoucherEvidence): SupplierInvoiceDto {
  const evidence: SupplierInvoiceEvidenceDto = {
    version: 1, voucherKind: 'unsupported', vatSource: 'unresolved', vatReason: 'no_invoice_vat', itemsComplete: false,
    ...(entry ? { sourceEntryId: entry.id, entryDate: entry.date } : {}),
  }
  const result: SupplierInvoiceDto = { ...dto, supplierEvidence: evidence,
    ...(entry ? { sourceVoucher: { series: entry.series, number: entry.number, date: entry.date } } : {}) }
  const total = dto.legalMonetaryTotal.payableAmount.value
  const lines = dto.lines
  const monetary = lines.filter(line => line.lineExtensionAmount.value !== 0)
  const validLines = lines.length > 0 && monetary.length > 0 && lines.every(line =>
    Number.isFinite(line.lineExtensionAmount.value) && line.lineExtensionAmount.value >= 0 &&
    (line.taxPercent == null || (Number.isFinite(line.taxPercent) && line.taxPercent >= 0)) &&
    line.unitPrice !== undefined && Number.isFinite(line.unitPrice.value) &&
    line.quantity !== undefined && Number.isFinite(line.quantity) && line.quantity > 0)
  const net = roundOre(lines.reduce((n, line) => n + line.lineExtensionAmount.value, 0))
  const stated = monetary.every(line => line.taxPercent != null && Number.isFinite(line.taxPercent) && line.taxPercent >= 0)
  const statedVat = roundOre(lines.reduce((n, line) => n + roundOre(line.lineExtensionAmount.value * (line.taxPercent ?? 0) / 100), 0))

  const accept = (vat: number, source: 'invoice_lines' | 'voucher') => {
    result.taxTotal = { taxAmount: { value: vat, currencyCode: dto.currencyCode } }
    result.legalMonetaryTotal = { ...dto.legalMonetaryTotal,
      lineExtensionAmount: { value: net, currencyCode: dto.currencyCode } }
    evidence.vatSource = source; evidence.vatReason = 'corroborated'
    evidence.itemsComplete = stated
    if (!stated) {
      const unknown = monetary.filter(line => line.taxPercent == null)
      // One unknown monetary line has a determinate residual. Two do not,
      // even when their blended rate happens to equal a statutory rate.
      if (unknown.length === 1) {
        const residual = roundOre(vat - statedVat)
        const rates = [0, 6, 12, 25].filter(rate => same(roundOre(unknown[0].lineExtensionAmount.value * rate / 100), residual))
        if (rates.length === 1) {
          result.lines = lines.map(line => line === unknown[0]
            ? { ...line, taxPercent: rates[0], taxAmount: { value: residual, currencyCode: dto.currencyCode } } : line)
          evidence.itemsComplete = true
        }
      }
    }
  }
  if (validLines && stated && same(net + statedVat, total)) accept(statedVat, 'invoice_lines')
  if (!entry) return result
  const fail = (reason: string) => { if (evidence.vatSource === 'unresolved') evidence.vatReason = reason; return result }
  if (dto.invoiceTypeCode === '381' || dto.currencyCode !== 'SEK' || !Number.isFinite(total) || total <= 0) return fail('unsupported_invoice')
  if (entry.reversingJournalEntryId || entry.reversedByJournalEntryId) return fail('reversed_voucher')
  if (!entry.items.length || entry.items.some(line => !ACCOUNT_NUMBER_RE.test(line.account) ||
    !Number.isFinite(line.debit) || !Number.isFinite(line.credit) || line.debit < 0 || line.credit < 0)) return fail('invalid_voucher')
  const debit = entry.items.reduce((n, line) => n + line.debit, 0)
  const credit = entry.items.reduce((n, line) => n + line.credit, 0)
  if (debit <= 0 || !same(debit, credit)) return fail('unbalanced_voucher')
  const netCredit = (prefix: string) => roundOre(entry.items.filter(line => line.account.startsWith(prefix)).reduce((n, line) => n + line.credit - line.debit, 0))
  const ap = netCredit('244'); const bank = netCredit('19')
  const hasAp = entry.items.some(line => line.account.startsWith('244'))
  evidence.voucherKind = same(ap, total) && same(bank, 0) ? 'registration'
    : same(bank, total) && !hasAp ? 'cash_purchase'
    : same(bank, total) && same(ap, -total) ? 'settlement' : 'unsupported'
  if (evidence.voucherKind === 'unsupported') return fail('voucher_amount_mismatch')
  if (evidence.voucherKind === 'settlement') return fail('payment_has_no_invoice_vat')
  if (entry.items.some(line => line.account.startsWith('26') && !['2640', '2641'].includes(line.account))) return fail('unsupported_vat_accounts')
  evidence.bookedVat = roundOre(entry.items.filter(line => ['2640', '2641'].includes(line.account)).reduce((n, line) => n + line.debit - line.credit, 0))
  if (!validLines) return fail('missing_invoice_net')
  if (evidence.bookedVat < 0 || !same(net + evidence.bookedVat, total)) return fail('invoice_net_mismatch')
  if (evidence.vatSource === 'unresolved') accept(evidence.bookedVat, 'voucher')
  return result
}
