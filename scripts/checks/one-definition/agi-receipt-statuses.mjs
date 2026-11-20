export default {
  rule: 'agi-receipt-statuses',
  says: 'An AGI declaration is on record as filed at Skatteverket when its status is submitted or accepted.',
  home: 'src/lib/deadlines/agi-filed.ts: AGI_RECEIPT_STATUSES',
  why: 'Payroll and the skattekonto payment each kept their own list while the deadline generator read none, so a period filed before its AGI deadline existed was created open (#201).',
  match: [/\[\s*['"]submitted['"],\s*['"]accepted['"]\s*\]/],
  sanctioned: ['lib/deadlines/agi-filed.ts'],
}
