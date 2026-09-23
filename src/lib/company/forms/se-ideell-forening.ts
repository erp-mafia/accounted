import type { LegalFormProfile } from './types'

/**
 * Ideell förening: a juridisk person with members and no owners. Result
 * closes to 2069 and is carried to 2068 at the next year start, mirroring the
 * AB 2099/2098 pair on the BAS 2060-2069 group (DECISIONS.md 2026-09-08).
 * Money settled with a member is a plain short-term liability on 2890.
 *
 * INK3 is the statutory return but is not modelled, so `incomeReturn` stays
 * null until it is; the same for årsbokslut and årsredovisning (#2072 step 2).
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
  },
  equity: {
    closing: '2069',
    closingName: 'Årets resultat',
    priorYearCarry: '2068',
    hasOwners: false,
    settlement: { withdrawal: '2890', contribution: '2890' },
  },
  filings: {
    incomeReturn: null,
    booksCurrentTax: false,
    corporateTaxDispositions: false,
    arsredovisning: false,
    frameworks: ['K1'],
  },
  glossary: { entity: 'föreningen', owner: 'Medlem', meeting: 'årsmöte' },
}
