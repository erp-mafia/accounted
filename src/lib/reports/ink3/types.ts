import type { Ink3Blankett, Ink3Column, Ink3Datatyp } from './field-table'

export type { Ink3Blankett, Ink3Column, Ink3Datatyp } from './field-table'

/**
 * How the company says an income or cost account relates to the taxable
 * activity (founder decision 2026-10-15, split per account): exempt accounts
 * stay out of the "som ska tas upp/dras av" column, taxable accounts go in
 * whole, and shared accounts need the user's own figure on the ruta.
 */
export const INK3_TREATMENTS = ['exempt', 'taxable', 'shared'] as const
export type Ink3Treatment = (typeof INK3_TREATMENTS)[number]

/** A value a field carries: whole kronor, a ticked box, or short text. */
export type Ink3FieldValue = number | boolean | string

/**
 * Where a field's value comes from:
 *   books     read from the ledger (INK3R balance sheet, bookkeeping column, taxable column of classified accounts)
 *   computed  arithmetic on other fields (6.20, 6.21, 7.1, 7.2, 7.9, 7.10) or the periodiseringsfond schablonintäkt (7.5a)
 *   input     entered by the user (the rest of INK3S, all of INK3SUF)
 *   override  the user's own figure in place of a books or computed value
 */
export type Ink3FieldSource = 'books' | 'computed' | 'input' | 'override'

export type Ink3NeedsInputReason =
  /** A shared account feeds the taxable column: only the user knows the taxable part. */
  | 'shared_account'
  /** An account with a balance has no treatment yet. */
  | 'unclassified_account'
  /** The value cannot be computed (e.g. no schablonintäkt rate for the year). */
  | 'not_computable'

export interface Ink3AccountLine {
  accountNumber: string
  accountName: string
  /** Whole kronor, in the field's own sign (a cost is positive in a minus box). */
  amount: number
  /** The account's treatment; set on the INK3R income statement lines only. */
  treatment: Ink3Treatment | null
}

export interface Ink3Field {
  code: string
  blankett: Ink3Blankett
  ruta: string | null
  /** Skatteverket's label (Swedish in both locales). */
  label: string
  column: Ink3Column | null
  sign: '+' | '-' | '*' | null
  datatyp: Ink3Datatyp
  /** What to type into the e-tjänst: the override when there is one. Null for an empty input. */
  value: Ink3FieldValue | null
  /** What the books or the arithmetic give before any override; null for a pure input. */
  computed: number | null
  source: Ink3FieldSource
  /** The user may replace the value. False only for the sums, which follow their parts. */
  overridable: boolean
  needsInput: boolean
  needsInputReason: Ink3NeedsInputReason | null
  accounts: Ink3AccountLine[]
}

/** An income or cost account the company classifies for the taxable column. */
export interface Ink3ClassifiableAccount {
  accountNumber: string
  accountName: string
  /** The INK3R ruta the account's balance lands on, e.g. '6.4'. */
  ruta: string
  /** Whole kronor, income positive and costs positive in their own boxes. */
  amount: number
  treatment: Ink3Treatment | null
}

export interface Ink3Underlag {
  fiscalYear: {
    id: string
    name: string
    start: string
    end: string
    isClosed: boolean
  }
  /** E.g. '2026P4': the beskattningsperiod whose Skatteverket field table the figures follow. */
  beskattningsperiod: string
  fieldTable: {
    beskattningsperiod: string
    files: string[]
  }
  companyInfo: {
    companyName: string
    orgNumber: string | null
  }
  /** The user's own statement; null until stated. The product never decides it. */
  allmannyttig: boolean | null
  /** INK3SUF belongs in the underlag only when the user states the förening is allmännyttig. */
  sufApplicable: boolean
  /** Every field of the pinned table, in Skatteverket's order (INK3R, INK3S, INK3SUF). */
  fields: Ink3Field[]
  /**
   * Field code to the value to file, for every field with something in it:
   * non-zero amounts, ticked boxes ('X') and text. INK3SUF only when it
   * applies. The shape an SRU bilaga would serialise.
   */
  filing: Record<string, number | string>
  /** Income and cost accounts with a balance in the taxable column's rutor, for classification. */
  accounts: Ink3ClassifiableAccount[]
  totals: {
    totalAssets: number
    totalEquityLiabilities: number
    /** 6.20: årets resultat enligt bokföringen (vinst positive). */
    bookkeepingResult: number
    /** 6.21: justerat resultat (vinst positive). */
    taxableResult: number
    /** 7.9 minus 7.10: överskott positive, underskott negative. */
    taxableSurplus: number
  }
  /** True when the allmännyttig statement is made and no field waits for input. */
  complete: boolean
  warnings: string[]
}

/** What the company has entered for one räkenskapsår (table ink3_underlag_inputs). */
export interface Ink3Inputs {
  allmannyttig: boolean | null
  accountTreatments: Record<string, Ink3Treatment>
  fieldOverrides: Record<string, Ink3FieldValue>
}
