import type { LegalFormProfile } from './types'

/** Aktiebolag: a juridisk person owned by shareholders, taxed through INK2. */
export const SE_AKTIEBOLAG: LegalFormProfile = {
  jurisdiction: 'SE',
  code: 'aktiebolag',
  label: 'Aktiebolag',
  identity: { orgId: 'organisationsnummer' },
  fiscalYear: { calendarOnly: false },
  bookkeeping: {
    defaultMethod: 'accrual',
    // BFNAR 2016:10 (K2) is the simplified ruleset an AB prepares under.
    simplifiedRegelverk: 'K2',
    templateColumn: 'ab',
  },
  equity: {
    closing: '2099',
    closingName: 'Årets resultat',
    priorYearCarry: '2098',
    hasOwners: true,
    settlement: { withdrawal: '2893', contribution: '2893' },
  },
  filings: {
    incomeReturn: 'INK2',
    booksCurrentTax: true,
    corporateTaxDispositions: true,
    arsredovisning: true,
    frameworks: ['K2', 'K3'],
  },
  glossary: { entity: 'bolaget', owner: 'Ägare', meeting: 'årsstämma' },
}
