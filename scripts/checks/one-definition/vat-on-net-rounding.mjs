export default {
  rule: 'vat-on-net-rounding',
  says: 'VAT on a net amount rounds once, in whole öre and basis points, an exact half öre up, on every door.',
  home: 'src/lib/bookkeeping/gross-split.ts: netVat',
  why: 'Each door multiplied in floating point and rounded on its own: 0,58 kr at 25 % booked 0,14 kr on a reverse-charge purchase and 0,15 kr on an invoice, and 2,75 kr at 6 % was 0,16 kr or 0,17 kr by door.',
  match: [
    // roundOre(net * vatRate), roundOre(net * item.vat_rate): FX rates carry no vat or tax in their name.
    /\b(?:roundOre|roundMoney|round)\(\s*\(?[\w.]+(?:\s*\?\?\s*\d+\s*\))?\s*\*\s*\(?[\w.]*(?:vat|Vat|VAT|tax[A-Z]|tax_)[\w.]*/,
    // roundOre(vatRate * net), the factors the other way round.
    /(?<![.\w])(?:roundOre|roundMoney|round)\(\s*[\w.]*(?:vat|Vat|VAT)[\w.]*[rR]ate\w*\s*\*/,
    // roundOre((net * rate) / 100), round(net * (rate / 100)): a percent is never an FX rate.
    /\b(?:roundOre|roundMoney|round)\(\s*\(?[\w.]+\s*\*\s*\(?[\w.]*[rR]ate\w*\s*\)?\s*\/\s*100\b/,
    // roundOre(net * 0.25): the Swedish rates spelled out.
    /\b(?:roundOre|roundMoney|round)\([^()]*(?:\([^()]*\)[^()]*)*\*\s*0\.(?:25|12|06)\s*\)/,
    // Math.round(net * vatRate * 100) / 100.
    /Math\.round\(\s*[\w.]+\s*\*\s*[\w.]*(?:vat|Vat|VAT)[\w.]*\s*\*\s*100\s*\)/,
  ],
  sanctioned: ['lib/bookkeeping/gross-split.ts'],
}
