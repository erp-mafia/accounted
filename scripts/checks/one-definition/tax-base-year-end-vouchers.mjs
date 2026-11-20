export default {
  rule: 'tax-base-year-end-vouchers',
  says: 'Bolagsskatt and the 25 % cap rest on the result the declaration reads: every result account of the year, whichever voucher booked it, the tax and the resultatavslut aside.',
  home: 'src/lib/bokslut/tax-provision/result-before-tax.ts: readYearResult',
  why: 'The base was the income statement, which leaves year_end out, plus a list of account groups, so a stock count stood in the declared result and not in the tax; #1253 had patched 78xx onto the same list.',
  match: [/\bstartsWith\('(?:78|88)'\)/],
  scan: ['lib/bokslut/'],
}
