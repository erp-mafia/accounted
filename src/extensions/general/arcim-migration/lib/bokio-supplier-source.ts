import type { SupplierInvoiceDto } from '@/lib/providers/dto'

/** Only identifiers and the evidence decision are retained, never the raw payload. */
export function bokioSupplierSource(dto: SupplierInvoiceDto, supplierId: string) {
  const uploadRefs = dto._raw?.uploadRefs as { id?: string }[] | undefined
  return {
    id: dto.id, supplier_id: supplierId, invoice_number: dto.invoiceNumber || null, invoice_date: dto.issueDate,
    total: Math.abs(dto.legalMonetaryTotal.payableAmount.value), currency: dto.currencyCode,
    is_credit_note: dto.invoiceTypeCode === '381', remaining_amount: dto.paymentStatus.balance?.value,
    voucher: dto.sourceVoucher, vat_source: dto.supplierEvidence?.vatSource,
    upload_ids: (uploadRefs ?? []).flatMap(ref => typeof ref.id === 'string' && ref.id ? [ref.id] : []),
  }
}
