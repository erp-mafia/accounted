import type { CollectionsSettlement } from '@accounted/connect-contract'

/**
 * The nine payouts the collections provider posted on its test environment
 * on 2026-10-14, as Connect answers them: contract settlements, the
 * provider's own balanced voucher read into payout terms (a kind paid to the
 * company is positive when it adds to the payout, a deducted kind positive
 * when it is taken from it). `raw` is left empty; the bank reference is the
 * test environment's own. SAMPLE_MULTI_CLAIM_SETTLEMENT below is a tenth,
 * over several claims.
 *
 * Every payout is one invoice: its principal (the capital collected, a
 * credit to the customer ledger in the provider's voucher), the payout
 * itself (`informational`, not in the payout: it is the payout, the debit to
 * the bank in the provider's voucher), and in four of them a pair of
 * `agency_fee_vat` lines, +50 and -40 (a debit 50 and a credit 40 on 2641 in
 * the provider's voucher, no base or rate shown) that take 10 from the
 * payout; one also returns fees the company paid in advance
 * (`cost_refund_to_creditor`, 300, a credit to 6062 in the provider's
 * voucher). The provider explained the pair on 2026-10-15: the VAT on its
 * own service fee, which it deducts from a VAT-registered company's payout
 * (it keeps the reminder fees and the interest; 1000000223 is such an
 * interest case). Whether the company may deduct it depends on a valid VAT
 * invoice from the provider (ML 17 kap 24 §), which the test settlement
 * document is not: the accountant decides, and a person places the pair.
 *
 *   ref         principal  payout  other lines
 *   1000000216      12500   12500  -
 *   1000000217       2400    2400  -
 *   1000000218       8000    8000  -
 *   1000000219      30000   30000  -
 *   1000000220       1900    1890  agency_fee_vat +50, -40
 *   1000000221      10000    9990  agency_fee_vat +50, -40
 *   1000000222       7500    7790  cost_refund_to_creditor 300; agency_fee_vat +50, -40
 *   1000000223       4000    3990  agency_fee_vat +50, -40
 *   1000000224       1000    1000  -
 */
export const SAMPLE_SETTLEMENTS: readonly CollectionsSettlement[] = [
  {
    settlementRef: '1000000216',
    paymentDate: '2026-10-13',
    amount: 12500,
    currency: 'SEK',
    statusOk: true,
    settlementDate: '2026-10-13',
    statusCode: 'OK/Valid',
    bankReference: '1241241231',
    lines: [
      { kind: 'principal', inPayout: true, amount: 12500, taxAmount: 0, recipient: 'creditor', caseRef: '205507', invoiceRef: 'qa-settle-inv-20261006-01', originalInvoiceRefs: [], providerType: 'Capital/Creditor/CustomerInvoice', description: null },
      { kind: 'informational', inPayout: false, amount: 12500, taxAmount: 0, recipient: 'creditor', caseRef: '205507', invoiceRef: 'qa-settle-inv-20261006-01', originalInvoiceRefs: [], providerType: 'Capital/Creditor/BankTransfer', description: null },
    ],
    raw: {},
  },
  {
    settlementRef: '1000000217',
    paymentDate: '2026-10-13',
    amount: 2400,
    currency: 'SEK',
    statusOk: true,
    settlementDate: '2026-10-13',
    statusCode: 'OK/Valid',
    bankReference: '1241241231',
    lines: [
      { kind: 'principal', inPayout: true, amount: 2400, taxAmount: 0, recipient: 'creditor', caseRef: '205510', invoiceRef: 'qa-settle-inv-20261006-04', originalInvoiceRefs: [], providerType: 'Capital/Creditor/CustomerInvoice', description: null },
      { kind: 'informational', inPayout: false, amount: 2400, taxAmount: 0, recipient: 'creditor', caseRef: '205510', invoiceRef: 'qa-settle-inv-20261006-04', originalInvoiceRefs: [], providerType: 'Capital/Creditor/BankTransfer', description: null },
    ],
    raw: {},
  },
  {
    settlementRef: '1000000218',
    paymentDate: '2026-10-13',
    amount: 8000,
    currency: 'SEK',
    statusOk: true,
    settlementDate: '2026-10-13',
    statusCode: 'OK/Valid',
    bankReference: '1241241231',
    lines: [
      { kind: 'principal', inPayout: true, amount: 8000, taxAmount: 0, recipient: 'creditor', caseRef: '205508', invoiceRef: 'qa-settle-inv-20261006-02', originalInvoiceRefs: [], providerType: 'Capital/Creditor/CustomerInvoice', description: null },
      { kind: 'informational', inPayout: false, amount: 8000, taxAmount: 0, recipient: 'creditor', caseRef: '205508', invoiceRef: 'qa-settle-inv-20261006-02', originalInvoiceRefs: [], providerType: 'Capital/Creditor/BankTransfer', description: null },
    ],
    raw: {},
  },
  {
    settlementRef: '1000000219',
    paymentDate: '2026-10-13',
    amount: 30000,
    currency: 'SEK',
    statusOk: true,
    settlementDate: '2026-10-13',
    statusCode: 'OK/Valid',
    bankReference: '1241241231',
    lines: [
      { kind: 'principal', inPayout: true, amount: 30000, taxAmount: 0, recipient: 'creditor', caseRef: '205509', invoiceRef: 'qa-settle-inv-20261006-03', originalInvoiceRefs: [], providerType: 'Capital/Creditor/CustomerInvoice', description: null },
      { kind: 'informational', inPayout: false, amount: 30000, taxAmount: 0, recipient: 'creditor', caseRef: '205509', invoiceRef: 'qa-settle-inv-20261006-03', originalInvoiceRefs: [], providerType: 'Capital/Creditor/BankTransfer', description: null },
    ],
    raw: {},
  },
  {
    settlementRef: '1000000220',
    paymentDate: '2026-10-13',
    amount: 1890,
    currency: 'SEK',
    statusOk: true,
    settlementDate: '2026-10-13',
    statusCode: 'OK/Valid',
    bankReference: '1241241231',
    lines: [
      { kind: 'principal', inPayout: true, amount: 1900, taxAmount: 0, recipient: 'creditor', caseRef: '205511', invoiceRef: 'qa-settle-inv-20261006-05', originalInvoiceRefs: [], providerType: 'Capital/Creditor/CustomerInvoice', description: null },
      { kind: 'informational', inPayout: false, amount: 1890, taxAmount: 0, recipient: 'creditor', caseRef: '205511', invoiceRef: 'qa-settle-inv-20261006-05', originalInvoiceRefs: [], providerType: 'Capital/Creditor/BankTransfer', description: null },
      { kind: 'agency_fee_vat', inPayout: true, amount: 50, taxAmount: 0, recipient: 'agency', caseRef: '205511', invoiceRef: 'qa-settle-inv-20261006-05', originalInvoiceRefs: [], providerType: 'None/None/Tax', description: null },
      { kind: 'agency_fee_vat', inPayout: true, amount: -40, taxAmount: 0, recipient: 'agency', caseRef: '205511', invoiceRef: 'qa-settle-inv-20261006-05', originalInvoiceRefs: [], providerType: 'None/None/Tax', description: null },
    ],
    raw: {},
  },
  {
    settlementRef: '1000000221',
    paymentDate: '2026-10-13',
    amount: 9990,
    currency: 'SEK',
    statusOk: true,
    settlementDate: '2026-10-13',
    statusCode: 'OK/Valid',
    bankReference: '1241241231',
    lines: [
      { kind: 'principal', inPayout: true, amount: 10000, taxAmount: 0, recipient: 'creditor', caseRef: '205512', invoiceRef: 'qa-settle-inv-20261006-06', originalInvoiceRefs: [], providerType: 'Capital/Creditor/CustomerInvoice', description: null },
      { kind: 'informational', inPayout: false, amount: 9990, taxAmount: 0, recipient: 'creditor', caseRef: '205512', invoiceRef: 'qa-settle-inv-20261006-06', originalInvoiceRefs: [], providerType: 'Capital/Creditor/BankTransfer', description: null },
      { kind: 'agency_fee_vat', inPayout: true, amount: 50, taxAmount: 0, recipient: 'agency', caseRef: '205512', invoiceRef: 'qa-settle-inv-20261006-06', originalInvoiceRefs: [], providerType: 'None/None/Tax', description: null },
      { kind: 'agency_fee_vat', inPayout: true, amount: -40, taxAmount: 0, recipient: 'agency', caseRef: '205512', invoiceRef: 'qa-settle-inv-20261006-06', originalInvoiceRefs: [], providerType: 'None/None/Tax', description: null },
    ],
    raw: {},
  },
  {
    settlementRef: '1000000222',
    paymentDate: '2026-10-13',
    amount: 7790,
    currency: 'SEK',
    statusOk: true,
    settlementDate: '2026-10-13',
    statusCode: 'OK/Valid',
    bankReference: '1241241231',
    lines: [
      { kind: 'principal', inPayout: true, amount: 7500, taxAmount: 0, recipient: 'creditor', caseRef: '205514', invoiceRef: 'qa-settle-inv-20261006-08', originalInvoiceRefs: [], providerType: 'Capital/Creditor/CustomerInvoice', description: null },
      { kind: 'cost_refund_to_creditor', inPayout: true, amount: 300, taxAmount: 0, recipient: 'creditor', caseRef: '205514', invoiceRef: 'qa-settle-inv-20261006-08', originalInvoiceRefs: [], providerType: 'CourtFee/Creditor/FeesPaidInAdvance', description: null },
      { kind: 'informational', inPayout: false, amount: 7790, taxAmount: 0, recipient: 'creditor', caseRef: '205514', invoiceRef: 'qa-settle-inv-20261006-08', originalInvoiceRefs: [], providerType: 'Capital/Creditor/BankTransfer', description: null },
      { kind: 'agency_fee_vat', inPayout: true, amount: 50, taxAmount: 0, recipient: 'agency', caseRef: '205514', invoiceRef: 'qa-settle-inv-20261006-08', originalInvoiceRefs: [], providerType: 'None/None/Tax', description: null },
      { kind: 'agency_fee_vat', inPayout: true, amount: -40, taxAmount: 0, recipient: 'agency', caseRef: '205514', invoiceRef: 'qa-settle-inv-20261006-08', originalInvoiceRefs: [], providerType: 'None/None/Tax', description: null },
    ],
    raw: {},
  },
  {
    settlementRef: '1000000223',
    paymentDate: '2026-10-13',
    amount: 3990,
    currency: 'SEK',
    statusOk: true,
    settlementDate: '2026-10-13',
    statusCode: 'OK/Valid',
    bankReference: '1241241231',
    lines: [
      { kind: 'principal', inPayout: true, amount: 4000, taxAmount: 0, recipient: 'creditor', caseRef: '205515', invoiceRef: 'qa-settle-inv-20261006-09', originalInvoiceRefs: [], providerType: 'Capital/Creditor/CustomerInvoice', description: null },
      { kind: 'informational', inPayout: false, amount: 3990, taxAmount: 0, recipient: 'creditor', caseRef: '205515', invoiceRef: 'qa-settle-inv-20261006-09', originalInvoiceRefs: [], providerType: 'Capital/Creditor/BankTransfer', description: null },
      { kind: 'agency_fee_vat', inPayout: true, amount: 50, taxAmount: 0, recipient: 'agency', caseRef: '205515', invoiceRef: 'qa-settle-inv-20261006-09', originalInvoiceRefs: [], providerType: 'None/None/Tax', description: null },
      { kind: 'agency_fee_vat', inPayout: true, amount: -40, taxAmount: 0, recipient: 'agency', caseRef: '205515', invoiceRef: 'qa-settle-inv-20261006-09', originalInvoiceRefs: [], providerType: 'None/None/Tax', description: null },
    ],
    raw: {},
  },
  {
    settlementRef: '1000000224',
    paymentDate: '2026-10-13',
    amount: 1000,
    currency: 'SEK',
    statusOk: true,
    settlementDate: '2026-10-13',
    statusCode: 'OK/Valid',
    bankReference: '1241241231',
    lines: [
      { kind: 'principal', inPayout: true, amount: 1000, taxAmount: 0, recipient: 'creditor', caseRef: '205516', invoiceRef: 'qa-settle-inv-20261006-10', originalInvoiceRefs: [], providerType: 'Capital/Creditor/CustomerInvoice', description: null },
      { kind: 'informational', inPayout: false, amount: 1000, taxAmount: 0, recipient: 'creditor', caseRef: '205516', invoiceRef: 'qa-settle-inv-20261006-10', originalInvoiceRefs: [], providerType: 'Capital/Creditor/BankTransfer', description: null },
    ],
    raw: {},
  },
]

/**
 * A payout over several claims (paid out 2026-10-14, read 2026-10-15), as
 * Connect answers it once a merged parent's own invoice is kept on its
 * lines. 15270 in all, three claim groups, one `informational` payout line
 * each:
 *
 *   group                                    principal  refund  payout line
 *   merged case of qa-settle-inv-20261014-11 (the parent, the company's
 *   first invoice), -12 and -13 (its children)
 *                                            2500 on -13          3990
 *                                            1500 on -12
 *   claim 203834 (no invoice of the company's)   10000              9990
 *   claim 203835 (no invoice of the company's)    1000     300      1290
 *
 * The provider's staff created the two claims without an invoice of the
 * company's on the test creditor: their lines carry the claim (`caseRef`)
 * and no `invoiceRef`. The capital lines of the merged case name the
 * children directly; its payout line and the VAT pair name the parent's own
 * invoice first, then the children (`originalInvoiceRefs`). The VAT pair,
 * +150 and -120, is three times the one-invoice pair: each group's payout
 * line is 10 lower than its capital (and refund), although the pair names
 * only the merged case.
 */
export const SAMPLE_MULTI_CLAIM_SETTLEMENT: CollectionsSettlement = {
  settlementRef: '1000000225',
  paymentDate: '2026-10-14',
  amount: 15270,
  currency: 'SEK',
  statusOk: true,
  settlementDate: '2026-10-14',
  statusCode: 'OK/Valid',
  bankReference: '1241241231',
  lines: [
    { kind: 'principal', inPayout: true, amount: 2500, taxAmount: 0, recipient: 'creditor', caseRef: '205629', invoiceRef: 'qa-settle-inv-20261014-13', originalInvoiceRefs: [], providerType: 'Capital/Creditor/CustomerInvoice', description: null },
    { kind: 'principal', inPayout: true, amount: 1500, taxAmount: 0, recipient: 'creditor', caseRef: '205628', invoiceRef: 'qa-settle-inv-20261014-12', originalInvoiceRefs: [], providerType: 'Capital/Creditor/CustomerInvoice', description: null },
    { kind: 'principal', inPayout: true, amount: 10000, taxAmount: 0, recipient: 'creditor', caseRef: '203834', invoiceRef: null, originalInvoiceRefs: [], providerType: 'Capital/Creditor/CustomerInvoice', description: null },
    { kind: 'principal', inPayout: true, amount: 1000, taxAmount: 0, recipient: 'creditor', caseRef: '203835', invoiceRef: null, originalInvoiceRefs: [], providerType: 'Capital/Creditor/CustomerInvoice', description: null },
    { kind: 'cost_refund_to_creditor', inPayout: true, amount: 300, taxAmount: 0, recipient: 'creditor', caseRef: '203835', invoiceRef: null, originalInvoiceRefs: [], providerType: 'CourtFee/Creditor/FeesPaidInAdvance', description: null },
    { kind: 'informational', inPayout: false, amount: 3990, taxAmount: 0, recipient: 'creditor', caseRef: null, invoiceRef: null, originalInvoiceRefs: ['qa-settle-inv-20261014-11', 'qa-settle-inv-20261014-12', 'qa-settle-inv-20261014-13'], providerType: 'Capital/Creditor/BankTransfer', description: null },
    { kind: 'informational', inPayout: false, amount: 9990, taxAmount: 0, recipient: 'creditor', caseRef: '203834', invoiceRef: null, originalInvoiceRefs: [], providerType: 'Capital/Creditor/BankTransfer', description: null },
    { kind: 'informational', inPayout: false, amount: 1290, taxAmount: 0, recipient: 'creditor', caseRef: '203835', invoiceRef: null, originalInvoiceRefs: [], providerType: 'Capital/Creditor/BankTransfer', description: null },
    { kind: 'agency_fee_vat', inPayout: true, amount: 150, taxAmount: 0, recipient: 'agency', caseRef: null, invoiceRef: null, originalInvoiceRefs: ['qa-settle-inv-20261014-11', 'qa-settle-inv-20261014-12', 'qa-settle-inv-20261014-13'], providerType: 'None/None/Tax', description: null },
    { kind: 'agency_fee_vat', inPayout: true, amount: -120, taxAmount: 0, recipient: 'agency', caseRef: null, invoiceRef: null, originalInvoiceRefs: ['qa-settle-inv-20261014-11', 'qa-settle-inv-20261014-12', 'qa-settle-inv-20261014-13'], providerType: 'None/None/Tax', description: null },
  ],
  raw: {},
}
