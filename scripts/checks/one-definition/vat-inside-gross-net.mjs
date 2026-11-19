export default {
  rule: 'vat-inside-gross-net',
  says: 'The net beside a gross amount is the gross minus splitGrossVat\'s VAT, never the gross divided by 1 + rate.',
  home: 'src/lib/bookkeeping/gross-split.ts: splitGrossVat',
  why: 'Rounding the net instead of the VAT lands on the other side of a 12 % half: 1,26 kr split as 1,12 + 0,14 on the booking paths and as 1,13 + 0,13 on a prefill, an import and a service charge.',
  match: [
    // gross / (1 + rate), gross / (1 + rate / 100), gross / 1.25. Not rate / (1 + rate), the share of VAT.
    /(?<![rR]ate\s)\/\s*\(\s*1\s*\+\s*[\w.]*(?:[rR]ate|[vV]at|[pP]ercent)\w*(?:\s*\/\s*100)?\s*\)/,
    /\b(?:gross|total|amount|proceeds)\w*\s*\/\s*1\.(?:25|12|06)\b/,
  ],
  sanctioned: ['lib/bookkeeping/gross-split.ts'],
}
