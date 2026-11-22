export default {
  rule: 'org-number-ten-digit-key',
  says: 'Any written form of a Swedish org or personal number reduces to one 10-digit key, a 12-digit form only from a 16, 18, 19 or 20 century.',
  home: 'src/lib/invariants/org-number.ts: orgNumberKey',
  why: 'Each copy read a 12-digit value its own way: some cut any 12 digits, which turns a VAT number into somebody else\'s number, and some only the 16 century, which refused 10,284 sole-trader customers in collections.',
  match: [
    /\.length === 12\b.*\.(slice|substring)\(2\)/,
    /\.startsWith\('16'\).*\.(slice|substring)\(2\)/,
    /\b\w*[oO]rg\w*\??\.replace\(\/(\\D|\[\^0-9\]|\[\^\\d\])\/g/,
  ],
  sanctioned: ['lib/invariants/org-number.ts', 'lib/invariants/personal-number-shape.ts'],
  allowed: {
    'lib/invoices/peppol-identifiers.ts': 'Mirrors the hosted connector (accounted-connect lib/peppol/identifiers.ts) so both sides route a document alike: changing it means changing both.',
    'lib/payments/initiating-party.ts': 'An older batch snapshot regenerates exactly as it was first downloaded. A new one holds the key already (resolveBatchDebtor).',
    'lib/payments/pain001-supplier.ts': 'As initiating-party.ts: the snapshot decides.',
    'lib/payments/batch-service.ts': 'The message id of a new batch, from the snapshot resolveBatchDebtor wrote as the key.',
    'lib/payments/initiation/connect.ts': 'Reduces nothing: companyOrgNumber already gave the key, and the contract wants digits.',
    'lib/reports/owner-identity-mask.ts': 'Spells one number the ways it may appear in stored text, so masking misses none: it reads no identity.',
    'lib/clients/aggregate.ts': 'A search box: the digits typed against the digits shown.',
    'lib/reports/ne-bilaga/sru-generator.ts': 'The name of the downloaded zip, as it has always been: no identity is read from it.',
  },
}
