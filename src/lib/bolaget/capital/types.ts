/**
 * Capital events in Bolaget: the shared vocabulary of the dividend register
 * (ABL 17-18 kap.), KU31 (SFL 24 kap.), aktieägartillskott (K2 15.5-15.6)
 * and the changes of aktiekapital (ABL 12, 13 and 20 kap.).
 *
 * Pure data with no server imports: client components read the enums for
 * their pickers. Every enum mirrors a CHECK in
 * supabase/migrations/20261030020000_bolaget_capital.sql.
 */

/** Who decided a dividend: only a bolagsstämma decides a vinstutdelning (ABL 18:1). */
export const DIVIDEND_DECIDED_BY = ['arsstamma', 'extra_stamma'] as const
export type DividendDecidedBy = (typeof DIVIDEND_DECIDED_BY)[number]

/** Who decided a capital change: the stämma, or the board under an authorisation (ABL 13:1). */
export const CAPITAL_DECIDED_BY = ['arsstamma', 'extra_stamma', 'styrelse'] as const
export type CapitalDecidedBy = (typeof CAPITAL_DECIDED_BY)[number]

/**
 * Which day's aktiebok decides who receives a dividend. The default is the
 * decision day: in a company outside Euroclear (a kupongbolag) the dividend
 * is at the holders' disposal on the stämma day unless the stämma decided
 * otherwise (Skatteverket, KU31 guidance). A later betalningsdag (ABL 18:3)
 * or another stated day can be chosen.
 */
export const RECORD_DATE_BASES = ['decision_date', 'payment_date', 'other'] as const
export type RecordDateBasis = (typeof RECORD_DATE_BASES)[number]

export const DIVIDEND_STATUSES = ['decided', 'booked', 'paid', 'cancelled'] as const
export type DividendStatus = (typeof DIVIDEND_STATUSES)[number]

/** The equity account a dividend decision is booked from: 2098 before the year's result is moved to 2091, else 2091. */
export const DIVIDEND_SOURCE_ACCOUNTS = ['2098', '2091'] as const
export type DividendSourceAccount = (typeof DIVIDEND_SOURCE_ACCOUNTS)[number]

/** Outtagen vinstutdelning: the liability from decision to payout. */
export const DIVIDEND_LIABILITY_ACCOUNT = '2898'
/** The default bank account of a payout or a payment. */
export const DEFAULT_BANK_ACCOUNT = '1930'

/** Aktiekapital, Ej registrerat aktiekapital, Fri överkursfond, Erhållna aktieägartillskott (BAS 2026). */
export const SHARE_CAPITAL_ACCOUNT = '2081'
export const UNREGISTERED_SHARE_CAPITAL_ACCOUNT = '2082'
export const SHARE_PREMIUM_ACCOUNT = '2097'
export const CONTRIBUTION_ACCOUNT = '2093'
/** Kortfristiga fordringar hos delägare eller närstående: a tillskott promised, not yet paid. */
export const CONTRIBUTION_RECEIVABLE_ACCOUNT = '1685'

export const CAPITAL_CHANGE_KINDS = ['nyemission', 'fondemission', 'minskning'] as const
export type CapitalChangeKind = (typeof CAPITAL_CHANGE_KINDS)[number]

/** The funds a fondemission may draw on (ABL 12:1): fritt eget kapital, reservfond, uppskrivningsfond, överkursfond. */
export const FONDEMISSION_SOURCE_ACCOUNTS = ['2091', '2097', '2086', '2085'] as const
export type FondemissionSourceAccount = (typeof FONDEMISSION_SOURCE_ACCOUNTS)[number]

/** The purposes of a minskning (ABL 20:1). */
export const MINSKNING_PURPOSES = ['forlusttackning', 'aterbetalning', 'fri_fond'] as const
export type MinskningPurpose = (typeof MINSKNING_PURPOSES)[number]

/** Where a minskning goes: covering a loss or a free fund is fritt eget kapital (2091); a repayment is owed to the holders (2890) until paid. */
export function minskningTargetAccount(purpose: MinskningPurpose): '2091' | '2890' {
  return purpose === 'aterbetalning' ? '2890' : '2091'
}

export const CAPITAL_CHANGE_STATUSES = ['decided', 'registered', 'cancelled'] as const
export type CapitalChangeStatus = (typeof CAPITAL_CHANGE_STATUSES)[number]

export const CONTRIBUTION_KINDS = ['contribution', 'repayment'] as const
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number]

export const DECIDED_BY_LABELS_SV: Record<CapitalDecidedBy, string> = {
  arsstamma: 'Årsstämma',
  extra_stamma: 'Extra bolagsstämma',
  styrelse: 'Styrelsen',
}

export const CAPITAL_CHANGE_LABELS_SV: Record<CapitalChangeKind, string> = {
  nyemission: 'Nyemission',
  fondemission: 'Fondemission',
  minskning: 'Minskning av aktiekapitalet',
}
