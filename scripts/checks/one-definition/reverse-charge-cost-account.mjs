export default {
  rule: 'reverse-charge-cost-account',
  says: 'A reverse-charge purchase is refused on a cost account that declares another box itself (trepartshandel ruta 37, the import basis ruta 50, the 4598 offset, a reverse-charge momskod without a 25, 12 or 6 % sats), and on an account with its own ruta 20-24 for another box than the one stated.',
  home: 'src/lib/bookkeeping/voucher-line-vat-code.ts: reverseChargeAccountConflict',
  why: 'The utlägg refused these accounts and the MCP door refused the stated-box mismatch, each by hand, while bank categorization through REST v1 and the dashboard booked the 45xx/4598 basis pair beside an account that already declared the purchase, so it landed in two boxes.',
  match: [
    // A fixed account's kind compared with the stated one by hand.
    /\.code\.kind\s*!==|!==\s*[\w.]*\.code\.kind\b/,
    // An account without a momskod refused by its class by hand.
    /mode\s*===\s*'none'\s*&&\s*[A-Z_]+\.test\(/,
    // The MCP door's own refusal of a box its cost account contradicts.
    /if\s*\([^)]*!==\s*ownAccount\.kind/,
  ],
  sanctioned: ['lib/bookkeeping/voucher-line-vat-code.ts'],
}
