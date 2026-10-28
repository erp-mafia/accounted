/** The trial balance columns the engine reads. */
export interface K1TrialBalanceRow {
  account_number: string
  account_name: string
  closing_debit: number
  closing_credit: number
}

/** One räkenskapsår's books, read twice (see trial-balance.ts ClosingEntryMode). */
export interface K1YearBalances {
  /** Every entry, resultatavslut included: the balansräkning. */
  full: readonly K1TrialBalanceRow[]
  /** Without the resultatavslut ('exclude-final'): the resultaträkning. */
  preClosing: readonly K1TrialBalanceRow[]
}

/** An account behind a post, for the JSON and the screen. The PDF never shows accounts. */
export interface K1PostAccount {
  account_number: string
  account_name: string
  current: number
  previous: number | null
}

export interface K1StatementRow {
  kind: 'rubrik' | 'post' | 'summa'
  key: string
  label: string
  /** Null on a rubrik. */
  current: number | null
  /** Null on a rubrik, and on every row when there is no comparison year. */
  previous: number | null
  /** Posts only. */
  accounts?: K1PostAccount[]
}

export interface K1Check {
  code: K1CheckCode
  message: string
}

export type K1CheckCode =
  // Blockers: the PDF is refused while any of these holds.
  | 'YEAR_NOT_CLOSED'
  | 'ACCOUNT_OUTSIDE_LAYOUT'
  | 'AVSATTNING_BOOKED'
  | 'BALANCE_SHEET_UNBALANCED'
  | 'RESULT_DIFFERS_FROM_CLOSING_ACCOUNT'
  | 'ELIGIBILITY_NOT_CONFIRMED'
  // Warnings: the document can be made, but something needs a look.
  | 'PREPAID_MEMBER_FEES'
  | 'MEMBER_FEE_RECEIVABLES'
  | 'NETTOOMSATTNING_ABOVE_LIMIT'
  | 'COMPARATIVE_YEAR_UNAVAILABLE'
  | 'COMPARATIVE_YEAR_DERIVED'
  | 'COMPARATIVE_YEAR_UNBALANCED'

export interface K1Amounts {
  current: number
  previous: number | null
}

export interface K1Computation {
  resultatrakning: K1StatementRow[]
  balansrakning: K1StatementRow[]
  totals: {
    aretsOverUnderskott: K1Amounts
    summaTillgangar: K1Amounts
    summaEgetKapitalOchSkulder: K1Amounts
    /**
     * Nettoomsättning as BFL 1 kap. 2 § reads it for a förening: medlemsavgifter,
     * gåvor och bidrag, övriga verksamhetsintäkter and försäljningsintäkter.
     */
    nettoomsattning: K1Amounts
  }
  blockers: K1Check[]
  warnings: K1Check[]
}
