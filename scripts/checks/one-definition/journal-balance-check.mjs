export default {
  rule: 'journal-balance-check',
  says: 'A verifikat balances on the amounts it stores: each line in whole öre, debits equal credits, both above zero.',
  home: 'src/lib/bookkeeping/line-balance.ts: lineBalance',
  why: 'Twelve doors summed raw lines and rounded the sum or the difference, each with its own tolerance, so 100,004 + 100,004 against 200,01 passed every check and failed at commit as 200,00 against 200,01.',
  match: [
    // Math.round((totalDebit - totalCredit) * 100) === 0.
    /Math\.round\(\(\s*(?:total|sum|rounded)?[dD]ebits?\w*\s*-\s*(?:total|sum|rounded)?[cC]redits?\w*\s*\)\s*\*\s*100\s*\)/,
    // Math.abs(debit - credit) < 0.005.
    /Math\.abs\(\s*[\w.]*[dD]ebit\w*\s*-\s*[\w.]*[cC]redit\w*\s*\)\s*[<>]=?/,
    // totalDebit === totalCredit, debits !== credits, debitOre === creditOre.
    /\b(?:(?:total|sum|rounded)[dD]ebit|debit)s?\w*\s*[!=]==\s*(?:(?:total|sum|rounded)[cC]redit|credit)\w*/,
    // roundOre(totalDebit - totalCredit) !== 0, !isZeroOre(debit - credit).
    /\b(?:roundOre|isZeroOre)\(\s*\w*[dD]ebit\w*\s*-\s*\w*[cC]redit\w*\s*\)\s*(?:[!=]==|\)|&&|\|\|)/,
    // !equalOre(totalDebit, totalCredit).
    /\bequalOre\(\s*\w*[dD]ebit\w*\s*,\s*\w*[cC]redit\w*\s*\)/,
    // A line's stored amount rounded by hand: storedLineValues is the one writer.
    /(?:debit|credit)_amount:\s*Math\.round\(\(\s*\w+\.(?:debit|credit)_amount/,
  ],
  sanctioned: ['lib/bookkeeping/line-balance.ts'],
  allowed: {
    'lib/reports/trial-balance.ts': 'The totals of a report over every account, not the lines of one verifikat.',
  },
}
