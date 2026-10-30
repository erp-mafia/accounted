import type { LegalFormProfile } from './types'

/**
 * Ideell förening: a juridisk person with members and no owners. Result
 * closes to 2069 and is carried to 2068 at the next year start, mirroring the
 * AB 2099/2098 pair on the BAS 2060-2069 group (DECISIONS.md 2026-09-08).
 * Money settled with a member is a plain short-term liability on 2890.
 *
 * The return is INK3, prepared as an underlag (lib/reports/ink3, #47): the
 * figures to type into Skatteverket's e-tjänst, no SRU file. Årsredovisning
 * is not modelled (#2072 step 2). The year-end document is the förenklat
 * årsbokslut in the BFNAR 2010:1 bilaga 2 layout.
 */
export const SE_IDEELL_FORENING: LegalFormProfile = {
  jurisdiction: 'SE',
  code: 'ideell_forening',
  label: 'Ideell förening',
  creationFlag: 'NEXT_PUBLIC_IDEELL_FORENING_ENABLED',
  identity: { orgId: 'organisationsnummer' },
  fiscalYear: { calendarOnly: false },
  bookkeeping: {
    defaultMethod: 'accrual',
    // BFNAR 2010:1 (K1 for ideella föreningar).
    simplifiedRegelverk: 'K1',
    templateColumn: 'base',
    skattekontoAccounts: ['1630'],
  },
  equity: {
    closing: '2069',
    closingName: 'Årets resultat',
    priorYearCarry: '2068',
    retained: '2067',
    hasOwners: false,
    settlement: { withdrawal: '2890', contribution: '2890' },
    memberCapital: false,
    developmentFund: false,
    maintenanceFund: null,
    shareRegister: false,
  },
  filings: {
    incomeReturn: 'INK3',
    booksCurrentTax: false,
    corporateTaxDispositions: false,
    arsredovisning: false,
    frameworks: ['K1'],
    ixbrl: false,
    auditorAlwaysRequired: false,
    forenklatArsbokslut: 'BFNAR 2010:1',
    revisorspateckningLagrum: null,
    cashFlowStatement: null,
    housingKeyRatios: false,
  },
  glossary: { entity: 'föreningen', owner: 'Medlem', meeting: 'årsmöte' },
}
