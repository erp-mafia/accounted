export default {
  rule: 'foreign-amount-to-ore',
  says: 'A foreign amount times a rate rounds to the öre one way at every door: on the written decimals, as Postgres numeric rounds it, with the sign outside the magnitude.',
  home: 'src/lib/bookkeeping/currency-utils.ts: sekOfForeign',
  why: 'Twenty-odd doors multiplied in floats, so a preview showed another 1510 than the RPC posted and a credit note landed one öre beside the invoice it cancels: 8 % of foreign invoices are exact half öre.',
  match: [
    // roundOre(amount * rate), round(...), the naive form: a rate named as an exchange rate.
    /\b(?:roundOre|round|TWO_DP)\([^;]*\*\s*\(?[\w.!]*(?:[eE]xchange_?[rR]ate|[fF]xRate|invRate|sekRate|closingRate|rateInfo\.rate|rate\.rate)\b/,
    /\bMath\.round\([^;]*\*\s*\(?[\w.!]*(?:[eE]xchange_?[rR]ate|[fF]xRate|invRate|sekRate|closingRate|rateInfo\.rate|rate\.rate)\b[^;]*\*\s*100\)\s*\/\s*100/,
  ],
  sanctioned: ['lib/bookkeeping/currency-utils.ts'],
}
