export default {
  rule: 'payslip-line-flags-by-type',
  says: 'The taxable, avgift, vacation and deduction flags of a payslip row follow from its type, so a row of one type means the same whichever door wrote it.',
  home: 'src/lib/salary/line-item-roles.ts: payslipLineFlags',
  why: 'The API doors defaulted every type to pay and stored what the caller sent, so a nettolöneavdrag through them never left the pay and 7210 booked D 40 500 where the dashboard booked D 40 000.',
  match: [/\bis_(taxable|avgift_basis|vacation_basis|gross_deduction|net_deduction):\s*(true|false)\b/],
  sanctioned: ['lib/salary/line-item-roles.ts'],
  allowed: {
    'lib/salary/vacation-days-pay.ts': 'The calculation refines these two flags per derived row: which vacation pay rows replace salary is not in the type.',
  },
}
