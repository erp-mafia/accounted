export default {
  rule: 'helarsmoms-eu-trade',
  says: 'Helårsmoms has the earlier EU-trade date when the setting says so or the räkenskapsår\'s own rutor show EU trade, decided in one function every door calls.',
  home: 'src/lib/reports/eu-trade.ts: helarsmomsHasEuTrade',
  why: 'The deadline rows read the setting alone and the VAT close check read setting or books: a company with EU trade booked but the setting off saw a later helårsmoms date on the deadline list than the close check named.',
  match: [
    // settings.vat_has_eu_trade === true || periodHasEuTrade, or without === true
    /vat_has_eu_trade\s*(?:===\s*true\s*)?\|\|/,
    // booksShowEuTrade || settings.vat_has_eu_trade (=== true), not a !== or ?? read
    /\|\|\s*[\w.?]*vat_has_eu_trade\b(?!\s*(?:!==|\?\?))/,
  ],
  sanctioned: ['lib/reports/eu-trade.ts'],
}
