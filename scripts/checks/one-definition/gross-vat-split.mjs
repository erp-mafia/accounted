export default {
  rule: 'gross-vat-split',
  says: 'The VAT inside a gross amount has one split: VAT to the öre, an exact half öre up, and the net as gross minus VAT.',
  home: 'src/lib/bookkeeping/gross-split.ts: splitGrossVat',
  why: 'The float forms decided 12 % halves by representation: 0,70 kr held 0,07 kr or 0,08 kr of VAT by door, so a ROT share and the invoice it came from could differ by an öre.',
  match: [
    // amount * rate / (1 + rate), amount * rate / (100 + rate).
    /\*\s*\(?[\w.]*[rR]ate\w*\s*\)?\s*\/\s*\(\s*(?:1|100)\s*\+\s*[\w.]*[rR]ate/,
    // gross * 0.2 and gross / 5 are the same split and read as anything else, so no regex takes them.
    // amount * (0.25 / 1.25), (amount * 0.25) / 1.25.
    /0?\.(?:25|12|06)\s*\)?\s*\/\s*1\.(?:25|12|06)\b/,
  ],
  sanctioned: ['lib/bookkeeping/gross-split.ts'],
  allowed: {
    'extensions/general/mcp-server/resources/booking-packs.ts': 'The formula in words for an agent writing a booking pack; it computes nothing.',
  },
}
