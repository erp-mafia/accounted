export default {
  rule: 'bankid-signatory-of-org-number',
  says: "A person is a firmatecknare of an org number when the register roles their own proven BankID login read, after the login was linked, list them in a position that signs for that company.",
  home: 'src/lib/company-lookup/signatory.ts: bankIdSignatoryProof, holdsSignatoryPosition',
  why: 'An org number in Accounted is typed, not proven, and a door that reads the register roles its own way (another set of positions, a role from before the link, an unconfirmed login) lets a company that typed another company\'s number act for it.',
  match: [/\bpositionTypes\b.*\.(includes|some|has|find)\(/, /['"]EFT['"]/],
  sanctioned: ['lib/company-lookup/signatory.ts'],
}
