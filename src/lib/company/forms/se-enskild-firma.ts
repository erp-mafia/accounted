import type { LegalFormProfile } from './types'

/** Enskild firma: a fysisk person who runs a business under their own personnummer. */
export const SE_ENSKILD_FIRMA: LegalFormProfile = {
  jurisdiction: 'SE',
  code: 'enskild_firma',
  label: 'Enskild firma',
  identity: { orgId: 'personnummer' },
  fiscalYear: { calendarOnly: true },
  bookkeeping: {
    defaultMethod: 'cash',
    // BFNAR 2006:1 (K1, förenklat årsbokslut).
    simplifiedRegelverk: 'K1',
    templateColumn: 'base',
  },
  equity: {
    closing: '2010',
    closingName: 'Eget kapital',
    priorYearCarry: null,
    hasOwners: true,
    settlement: { withdrawal: '2013', contribution: '2018' },
    memberCapital: false,
  },
  filings: {
    incomeReturn: 'NE',
    booksCurrentTax: false,
    corporateTaxDispositions: false,
    arsredovisning: false,
    frameworks: ['K1'],
    ixbrl: false,
    auditorAlwaysRequired: false,
  },
  glossary: { entity: 'firman', owner: 'Ägare', meeting: null },
}
