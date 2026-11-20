export default {
  rule: 'treatment-to-revenue-account',
  says: "A sale's treatment, legal form and goods-or-services nature pick one revenue account, so it lands in the right ruta on every door.",
  home: 'src/lib/bookkeeping/invoice-accounts.ts: getRevenueAccount',
  why: 'The category path held its own switch: goods sold abroad landed in the services rutor 39 and 40 instead of 35 and 36, on the very treatments an invoice got right.',
  match: [
    /\bgetIncomeAccount\b/,
    /case '(?:standard_25|reduced_12|reduced_6|export|exempt|reverse_charge|reverse_charge_domestic)':\s*return '3\d{3}'/,
    /\b(?:standard_25|reduced_12|reduced_6|export|exempt)['"]?\s*[:?]\s*['"]3\d{3}['"]/,
  ],
}
