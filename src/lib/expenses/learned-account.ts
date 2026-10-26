/**
 * The cost account an utlägg opens with: what the company booked this
 * merchant on before, instead of an empty field on every receipt (PH 101:
 * "jag måste ... välja konto" each time).
 *
 * In order:
 *   1. counterparty: the account the company's own history books this
 *      counterparty on (its counterparty template), read by the same rule
 *      "Bokför direkt" and "Privat, med mina egna pengar" apply
 *      (templateCostAccount in lib/inkorg/owner-paid.ts), so the three
 *      doors that book a receipt without a bank row propose alike;
 *   2. previous_claim: the account the company's latest utlägg for the same
 *      merchant was booked on. Utlägg teach no template (the credit side is
 *      the person, not a bank). In prod 2026-10-26, 69 of the 73 utlägg in
 *      60 days for a merchant claimed before were booked on the account of
 *      the time before, picked by hand each time.
 *
 * Both sources hold cost accounts only: templateCostAccount keeps an expense
 * account paid from a cash ledger, and a claim was refused on anything else
 * (CreateExpenseClaimSchema). An account no longer in the company's chart is
 * passed over once the chart is known. Null: the field stays empty for the
 * person to pick, as before. A proposal, never a booking: the person sees it
 * in the field and in the verifikat preview before anything posts.
 *
 * Framework-free: the dialog reads the template and the claims and asks this.
 */

/** The fields of an expense claim row this reads. */
export interface ExpenseAccountHistoryRow {
  description?: string | null
  expense_account?: string | null
  created_at?: string | null
}

export type LearnedExpenseAccountBasis = 'counterparty' | 'previous_claim'

export interface LearnedExpenseAccount {
  account: string
  basis: LearnedExpenseAccountBasis
}

/** A merchant as the claims compare it: case, spacing and surrounding blanks do not count. */
export function merchantKey(raw: string | null | undefined): string {
  return (raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function learnedExpenseAccount(input: {
  /** The counterparty template's cost account for the merchant (templateCostAccount), or null. */
  templateAccount: string | null
  /** The merchant as read (the seller's name the claim's description starts from). */
  merchant: string | null
  claims: readonly ExpenseAccountHistoryRow[]
  /** The company's account numbers; empty or absent: not known yet, nothing is ruled out by it. */
  chart?: ReadonlySet<string> | null
}): LearnedExpenseAccount | null {
  const usable = (account: string | null | undefined): account is string =>
    !!account && (!input.chart || input.chart.size === 0 || input.chart.has(account))

  const template = input.templateAccount?.trim() ?? null
  if (usable(template)) return { account: template, basis: 'counterparty' }

  const key = merchantKey(input.merchant)
  if (!key) return null
  let latest: { account: string; at: number } | null = null
  for (const claim of input.claims) {
    const account = claim.expense_account?.trim()
    if (merchantKey(claim.description) !== key || !usable(account)) continue
    const parsed = claim.created_at ? Date.parse(claim.created_at) : Number.NaN
    const at = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
    if (!latest || at > latest.at) latest = { account, at }
  }
  return latest ? { account: latest.account, basis: 'previous_claim' } : null
}
