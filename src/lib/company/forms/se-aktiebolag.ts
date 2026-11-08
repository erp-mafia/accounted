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
    skattekontoAccounts: ['1630'],
  },
  equity: {
    closing: '2099',
    closingName: 'Årets resultat',
    priorYearCarry: '2098',
    retained: '2091',
    hasOwners: true,
    settlement: { withdrawal: '2893', contribution: '2893' },
    memberCapital: false,
    developmentFund: true,
    maintenanceFund: null,
    shareRegister: true,
  },
  filings: {
    incomeReturn: 'INK2',
    booksCurrentTax: true,
    corporateTaxDispositions: true,
    arsredovisning: true,
    frameworks: ['K2', 'K3'],
    ixbrl: true,
    k3Document: true,
    auditorAlwaysRequired: false,
    forenklatArsbokslut: null,
    revisorspateckningLagrum: 'ABL 9 kap. 28 §',
    cashFlowStatement: 'larger',
    housingKeyRatios: false,
  },
  glossary: { entity: 'bolaget', owner: 'Ägare', meeting: 'årsstämma' },
}
