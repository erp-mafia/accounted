import type { EntityType } from '@/types'

/**
 * What the ledger knows about one legal form. Contract: docs/LEGAL-FORMS.md.
 *
 * A form is data (one object below per form); a capability is the API (a
 * field on that object). Code asks what a company can do and never which
 * form it is, so the fourth form is one more profile, not another sweep of
 * `=== 'aktiebolag'` sites. Every field must have at least two forms that
 * answer it differently; a field every form answers the same way is a
 * constant and does not belong here.
 *
 * The fields describe what THIS PRODUCT does for the form, not what the law
 * says in general. `filings.incomeReturn` is null for a form whose return is
 * not modelled yet, even when the statute names one (ideell förening: INK3).
 */
export interface LegalFormProfile {
  /** ISO 3166-1 alpha-2. Fixed until a second country exists; then a key, not a refactor. */
  jurisdiction: 'SE'
  /** DB value and v1 API value. Never renamed. */
  code: EntityType
  /** Statutory Swedish name, shown as-is in both locales. */
  label: string
  /**
   * `NEXT_PUBLIC_*` variable that gates creation while the form is in beta;
   * absent when the form is open to everyone. The read itself lives in
   * lib/company/entity-type.ts because Next.js only inlines a literal
   * `process.env.NEXT_PUBLIC_X` spelling into client bundles.
   */
  creationFlag?: string

  identity: {
    /** Whether the company's org number is the owner's personnummer. */
    orgId: 'personnummer' | 'organisationsnummer'
  }
  fiscalYear: {
    /** BFL 3 kap 1 §: a fysisk person is bound to the calendar year. */
    calendarOnly: boolean
  }
  bookkeeping: {
    defaultMethod: 'cash' | 'accrual'
    /** Regelverk label for the 5 000 kr accrual threshold (K1: may stay unperiodised). */
    simplifiedRegelverk: 'K1' | 'K2'
    /**
     * Which column of a booking template the form reads: the base column is
     * written for an enskild firma, `_ab` overrides it for an aktiebolag.
     */
    templateColumn: 'base' | 'ab'
  }
  equity: {
    /** Account the year's net result is closed to. */
    closing: string
    closingName: string
    /** Account the prior year's result is moved to at the next year start; null when the form closes straight into equity. */
    priorYearCarry: string | null
    /** Whether someone owns the company (egna uttag, aktieägare). A förening has members, not owners. */
    hasOwners: boolean
    /** Money settled with the owner or member: EF 2013/2018, AB 2893, förening 2890. */
    settlement: { withdrawal: string; contribution: string }
    /**
     * Bound equity is member capital (medlemsinsatser 2083, förlagsinsatser
     * 2084, ÅRL 3 kap. 10 b §) rather than aktiekapital 2081.
     */
    memberCapital: boolean
  }
  filings: {
    /** The income return the product prepares for the form; null when none is modelled. */
    incomeReturn: 'INK2' | 'NE' | 'INK3' | null
    /** Whether the year-end books the year's income tax as a liability (AB 2510/8910). */
    booksCurrentTax: boolean
    /** Periodiseringsfond and överavskrivningar proposals in the year-end wizard. */
    corporateTaxDispositions: boolean
    /** Whether the product prepares an årsredovisning for the form. */
    arsredovisning: boolean
    /** Frameworks the product offers the form. */
    frameworks: ReadonlyArray<'K1' | 'K2' | 'K3'>
    /** Whether a Bolagsverket iXBRL taxonomy covers the form's årsredovisning (K2 AB only today). */
    ixbrl: boolean
    /** A revisor is required whatever the size (EFL 8 kap. 1 §); an AB may opt out below ABL 9 kap. 1 §. */
    auditorAlwaysRequired: boolean
  }
  /**
   * Swedish nouns that differ by law, for labels that name the thing on its
   * own. Sentences stay form-neutral ("företaget", "verksamheten"): Swedish
   * gender agreement makes a substituted noun inside a sentence wrong.
   */
  glossary: {
    /** Definite form: "bolaget", "föreningen", "firman". */
    entity: string
    /** Indefinite singular, capitalised as a label: "Ägare", "Medlem". */
    owner: string
    /** The annual meeting, or null when the form has none. */
    meeting: string | null
  }
}

/**
 * A form we are asked for and have scoped but cannot create yet. Shown in
 * the onboarding picker as a stop with "kommer snart", never as a choice.
 */
export interface PlannedLegalForm {
  jurisdiction: 'SE'
  /** Future `EntityType` value; not a member of the union until it ships. */
  code: string
  label: string
  /** Public tracker or PR, when there is one. */
  reference?: string
}
