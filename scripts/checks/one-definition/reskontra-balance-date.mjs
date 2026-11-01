export default {
  rule: 'reskontra-balance-date',
  says: 'The reskontra compared with 1510 or 2440 at a fiscal year end is the reskontra as of that balance date, the figure the ledger itself shows for the day.',
  home: 'src/lib/reports/reskontra-balance-date.ts: reskontraBalanceDate',
  why: 'The reconciliation summed the invoices open today against the UB of the year, so every past year read a false Ej avstämd and a false bokslut warning.',
  match: [/\bfetch(?:Ar|Supplier)LedgerInvoices\(/],
  sanctioned: [
    'lib/reports/ar-ledger.ts',
    'lib/reports/ar-ledger-invoices.ts',
    'lib/reports/supplier-ledger.ts',
    'lib/reports/supplier-ledger-invoices.ts',
  ],
  allowed: {
    'app/api/reports/ar-ledger/customer/[customerId]/invoices/route.ts': 'The drill-down of one customer: its invoices, no total to compare with the books.',
    'app/api/reports/supplier-ledger/supplier/[supplierId]/invoices/route.ts': 'The drill-down of one supplier: its invoices, no total to compare with the books.',
  },
}
