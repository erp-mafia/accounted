export default {
  rule: 'legal-or-personal-number',
  says: 'Whether a Swedish number belongs to a legal or a natural person is one test on the number.',
  home: 'src/lib/invariants/org-number.ts: swedishNumberKind',
  why: 'A Swedish company with a 16 in front came out individual in the customer import and non_eu_business in the provider migration, which invoices it as an export, while two functions named isLegalPersonOrgNumber answered differently for the same number.',
  match: [
    /Number\(\w+\[2\]\)\s*(<|>=)\s*2/,
    /\[2\]\s*(<=|>=)\s*'[12]'/,
    /\\d\{2\}\[2-9\]/,
    /function isLegalPerson\w*\(/,
  ],
  sanctioned: ['lib/invariants/org-number.ts'],
}
