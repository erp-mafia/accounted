export default {
  rule: 'payslip-line-sign',
  says: 'A deduction row is negative and a positive row on a nettolöneavdrag repays the employee, in the pay calculation and in the voucher alike.',
  home: 'src/lib/salary/line-item-roles.ts: payslipLineSign',
  why: 'The engine took the absolute value of the deductions while the voucher read their sign, so a positive row was deducted, debited and refused as unbalanced.',
  match: [/Math\.abs\(\s*\w*[Dd]eduction\w*\.reduce\(/],
  scan: ['lib/salary/'],
}
