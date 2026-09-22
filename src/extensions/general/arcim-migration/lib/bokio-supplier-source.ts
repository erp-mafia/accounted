import type { SupabaseClient } from '@supabase/supabase-js'
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

export async function recordBokioSupplierSources(supabase: SupabaseClient, companyId: string, consentId: string,
  records: { invoice_id: string; source: ReturnType<typeof bokioSupplierSource>; voucher_id?: string }[]) {
  const { data, error } = await supabase.rpc('complete_bokio_supplier_invoice', {
    p_company_id: companyId, p_consent_id: consentId, p_invoice_id: null, p_run_id: crypto.randomUUID(),
    p_source: records, p_expected: null, p_plan: { origin: 'import' }, p_dry_run: false,
  })
  if (error || data?.receipts?.some((receipt: { outcome: string }) => ['concurrent_change', 'not_found'].includes(receipt.outcome))) {
    throw new Error('BOKIO_IMPORT_PROVENANCE_DEFERRED')
  }
}
