export default {
  rule: 'duplicate-guard-override-record',
  says: 'A payment booked past the duplicate warning leaves one record in the behandlingshistorik, written by the settlement, on every door.',
  home: 'src/lib/invoices/duplicate-guard-history.ts: recordInvoiceDuplicateGuardBypass, recordSupplierInvoiceDuplicateGuardBypass',
  why: 'Only the MCP approval recorded a customer override, in processing_history, which the behandlingshistorik does not read; the dashboard and v1 only logged it.',
  match: [/eventType:\s*['"]InvoiceDuplicatePaymentDismissed['"]/],
}
