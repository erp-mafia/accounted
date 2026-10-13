/**
 * What in the ledger means an aktiebolag (or ekonomisk förening) has to file
 * kontrolluppgifter on 31 January that the arbetsgivardeklaration never
 * covers, and which postings say so.
 *
 *   - Ränta to a private lender. A loan from the owner or another närstående
 *     person sits on 2393 (långfristig) or 2893 (kortfristig). The loan
 *     itself reports nothing: principal in and out is no income, and an
 *     interest-free loan has no kontrolluppgift at all. Interest paid or
 *     credited on it does (SFL 17 kap. 1-3 §§), unless the person's interest
 *     for the year is under 100 kr (SFL 17 kap. 4 § 2)
 *     (swedish-daily-bookkeeping, references/skattekonto-and-owner.md, 2.4).
 *     The company books it on the 8400-8429 räntekostnader in the same
 *     verifikat as the loan account: interest added to the loan
 *     (D 84xx / K 2393), paid with an amortisation (D 2393 + D 84xx /
 *     K 1930), or accrued beside a loan movement. Interest paid in a
 *     verifikat of its own (D 84xx / K 1930) cannot be told from interest to
 *     a bank and is not counted.
 *   - Utdelning, any posting on 2898 Outtagen vinstutdelning (KU31).
 *
 * Interest is summed per calendar year (the inkomstår a kontrolluppgift
 * covers). The caller passes posted verifikat only, without stornos: a
 * reversed verifikat and its storno are no event. The 100 kr floor is per
 * person; the ledger does not say how many lenders there are, so the company
 * total is compared, which can only fire in a case the floor would have let
 * pass, never miss one.
 */
import { roundOre } from '@/lib/money'

/** Lån från närstående personer: långfristig and kortfristig del. */
export const OWNER_LOAN_ACCOUNTS = ['2393', '2893'] as const
/** Outtagen vinstutdelning. */
export const DIVIDEND_ACCOUNT = '2898'
/** Interest below this per year needs no kontrolluppgift (SFL 17 kap. 4 § 2). */
export const KU_INTEREST_FLOOR = 100

/** Räntekostnader 8400-8429, without tax interest (8423) and supplier late interest (8422). */
export function isOwnerLoanInterestAccount(accountNumber: string): boolean {
  if (!/^84[0-2]\d$/.test(accountNumber)) return false
  return accountNumber !== '8422' && accountNumber !== '8423'
}

export interface KuSignalLine {
  journal_entry_id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  /** entry_date of the verifikat, YYYY-MM-DD. */
  entry_date: string
}

export type KuSignalTrigger =
  | {
      kind: 'owner_loan_interest'
      year: number
      amount: number
      interest_accounts: string[]
      loan_accounts: string[]
    }
  | { kind: 'dividend'; account_number: typeof DIVIDEND_ACCOUNT; amount: number }

/**
 * The triggers in these lines, interest years with the most recent first.
 * `excludedEntryIds` are verifikat that are no business event (the
 * bokslutsverifikat that moves the year's result).
 */
export function kuSignalTriggers(
  lines: KuSignalLine[],
  excludedEntryIds: ReadonlySet<string> = new Set(),
): KuSignalTrigger[] {
  const byEntry = new Map<string, KuSignalLine[]>()
  for (const line of lines) {
    if (excludedEntryIds.has(line.journal_entry_id)) continue
    const group = byEntry.get(line.journal_entry_id) ?? []
    group.push(line)
    byEntry.set(line.journal_entry_id, group)
  }

  const interestByYear = new Map<number, { amount: number; interest: Set<string>; loans: Set<string> }>()
  let dividendDebit = 0
  let dividendCredit = 0
  for (const group of byEntry.values()) {
    for (const line of group) {
      if (line.account_number !== DIVIDEND_ACCOUNT) continue
      dividendDebit += line.debit_amount
      dividendCredit += line.credit_amount
    }
    const loans = group.filter((l) => (OWNER_LOAN_ACCOUNTS as readonly string[]).includes(l.account_number))
    if (loans.length === 0) continue
    const interest = group.filter((l) => isOwnerLoanInterestAccount(l.account_number))
    if (interest.length === 0) continue
    const year = Number(group[0].entry_date.slice(0, 4))
    const bucket = interestByYear.get(year) ?? { amount: 0, interest: new Set<string>(), loans: new Set<string>() }
    for (const line of interest) {
      bucket.amount += line.debit_amount - line.credit_amount
      bucket.interest.add(line.account_number)
    }
    for (const line of loans) bucket.loans.add(line.account_number)
    interestByYear.set(year, bucket)
  }

  const triggers: KuSignalTrigger[] = []
  for (const [year, bucket] of [...interestByYear].sort((a, b) => b[0] - a[0])) {
    const amount = roundOre(bucket.amount)
    if (amount < KU_INTEREST_FLOOR) continue
    triggers.push({
      kind: 'owner_loan_interest',
      year,
      amount,
      interest_accounts: [...bucket.interest].sort(),
      loan_accounts: [...bucket.loans].sort(),
    })
  }
  // The utdelning paid out (debit) is what a KU31 reports; a dividend only
  // decided so far (credit) still announces one.
  const dividend = roundOre(dividendDebit > 0 ? dividendDebit : dividendCredit)
  if (dividend > 0) triggers.push({ kind: 'dividend', account_number: DIVIDEND_ACCOUNT, amount: dividend })
  return triggers
}
