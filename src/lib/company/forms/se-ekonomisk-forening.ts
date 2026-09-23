import type { LegalFormProfile } from './types'

/**
 * Ekonomisk förening: a juridisk person with members, not owners, taxed
 * through INK2 like an aktiebolag (IL 65 kap. 10 §). Result closes to 2099
 * and carries to 2098, the AB pair. Bound equity is member capital
 * (medlemsinsatser 2083, förlagsinsatser 2084, EFL 10-11 kap.) instead of
 * aktiekapital, and money settled with a member is a plain liability on 2890.
 *
 * Every ekonomisk förening prepares an årsredovisning (BFL 6 kap. 1 §) and
 * must have a revisor whatever its size (EFL 8 kap. 1 §). K3 is permitted by
 * law but not offered yet: the K3 equity roll-forward is shaped for
 * aktiekapital (docs/research/ekonomisk-forening-support-design.md, phase 2).
 */
export const SE_EKONOMISK_FORENING: LegalFormProfile = {
  jurisdiction: 'SE',
  code: 'ekonomisk_forening',
  label: 'Ekonomisk förening',
  creationFlag: 'NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED',
  identity: { orgId: 'organisationsnummer' },
  fiscalYear: { calendarOnly: false },
  bookkeeping: {
    defaultMethod: 'accrual',
    simplifiedRegelverk: 'K2',
    // A juridisk person with employees books like an aktiebolag (7610
    // utbildning, 3004 momsfri försäljning); owner accounts in that column
    // become 2890 because a förening has no owner.
    templateColumn: 'ab',
  },
  equity: {
    closing: '2099',
    closingName: 'Årets resultat',
    priorYearCarry: '2098',
    hasOwners: false,
    settlement: { withdrawal: '2890', contribution: '2890' },
    memberCapital: true,
  },
  filings: {
    incomeReturn: 'INK2',
    booksCurrentTax: true,
    corporateTaxDispositions: true,
    arsredovisning: true,
    frameworks: ['K2'],
    ixbrl: false,
    auditorAlwaysRequired: true,
  },
  glossary: { entity: 'föreningen', owner: 'Medlem', meeting: 'föreningsstämma' },
}
