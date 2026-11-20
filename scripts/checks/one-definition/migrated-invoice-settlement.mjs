export default {
  rule: 'migrated-invoice-settlement',
  says: 'A provider invoice has one reading of paid, part paid and open, so a row never reads paid with money open, on either register.',
  home: 'src/lib/providers/settlement.ts: resolveInvoiceSettlement',
  why: 'The sales and supplier importers each read the payment fields: one balance read paid on one register and sent on the other, and a provider status of paid landed beside the whole amount open.',
  match: [/\bpaymentStatus\.paid\s*\?/, /\bpaymentStatus\.paid\s*\|\|/, /\btrustedBalance\(/],
  sanctioned: ['lib/providers/settlement.ts'],
  scan: ['extensions/general/arcim-migration/'],
}
