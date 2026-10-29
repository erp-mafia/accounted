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
    // 1630 by default (full BAS 2026); 2012 Avräkning för skatter och
    // avgifter (skattekonto) in eget kapital when the firm runs it there
    // (BAS K1 chart, Fortnox, Björn Lundén): the firm shares its skattekonto
    // with the owner (PH 175).
    skattekontoAccounts: ['1630', '2012'],
  },
  equity: {
    closing: '2010',
    closingName: 'Eget kapital',
    priorYearCarry: null,
    retained: '2010',
    hasOwners: true,
    settlement: { withdrawal: '2013', contribution: '2018' },
    memberCapital: false,
    maintenanceFund: null,
    shareRegister: false,
  },
  filings: {
    incomeReturn: 'NE',
    booksCurrentTax: false,
    corporateTaxDispositions: false,
    arsredovisning: false,
    frameworks: ['K1'],
    ixbrl: false,
    auditorAlwaysRequired: false,
    forenklatArsbokslut: null,
    revisorspateckningLagrum: null,
    cashFlowStatement: null,
    housingKeyRatios: false,
  },
  glossary: { entity: 'firman', owner: 'Ägare', meeting: null },
}
