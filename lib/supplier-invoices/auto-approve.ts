/**
 * Whether the dashboard create flow should POST /approve after registering a
 * leverantörsfaktura. Enskild firma always does (registerer === attester).
 * Aktiebolag only when company_settings.auto_approve_supplier_invoices is on.
 */
export function shouldAutoApproveSupplierInvoice(
  isEF: boolean,
  autoApproveSetting: boolean,
): boolean {
  return isEF || autoApproveSetting
}
