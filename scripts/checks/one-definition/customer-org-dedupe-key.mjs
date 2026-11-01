export default {
  rule: 'customer-org-dedupe-key',
  says: 'A register import, a provider migration and a card merge decide that two cards are one party on one key: the 10-digit key for a Swedish number, the letters and digits for a foreign one.',
  home: 'src/lib/invariants/org-number.ts: partyOrgKey (public.party_org_key in SQL)',
  why: 'The customer key kept digits only, so a stored number and its 12-digit form became two cards, and BE and FR numbers with the same digits became one customer, written over.',
  match: [
    /\.replace\(\/\[\^0-9a-z\]\/gi/,
    /orgNumberKey\([^)]*\)\s*\?\?\s*\(?\w+\??\.trim\(\)/,
  ],
  sanctioned: ['lib/invariants/org-number.ts'],
  allowed: {
    'lib/api/schemas.ts': 'Not a compare: the form suppliers.org_number is stored in.',
  },
}
