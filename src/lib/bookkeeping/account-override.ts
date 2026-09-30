import type { SupabaseClient } from '@supabase/supabase-js'
import type { MappingResult } from '@/types'
import { costAccountReportsRcBasis, isReverseChargeBasisLeg } from './vat-entries'

/**
 * Reconcile a reverse-charge purchase's basis pair with the account its cost
 * line was moved to. The category path adds the 45xx/4598 pair for its own
 * default cost account; when an override puts the cost line on an account
 * that reports ruta 20-24 by itself (a BAS basis account such as 4535, or a
 * class 4-6 account configured with a reverse_charge_* treatment, per
 * costAccountReportsRcBasis with the chart row's treatment), the pair would
 * count the purchase twice. The fiktiv moms (2645/2614) stays either way.
 *
 * Only the money-out side can carry a reverse-charge purchase, so an income
 * override is left alone. Shared by every account_override path (MCP and
 * approval commit via applyAccountOverride, the dashboard and v1 routes).
 */
export function reconcileRcBasisWithCostAccount(
  mappingResult: MappingResult,
  transactionAmount: number,
  account: string,
  accountVatTreatment: string | null,
): MappingResult {
  if (transactionAmount >= 0) return mappingResult
  if (!costAccountReportsRcBasis(account, accountVatTreatment)) return mappingResult
  if (!mappingResult.vat_lines.some((l) => isReverseChargeBasisLeg(l.account_number))) return mappingResult
  return {
    ...mappingResult,
    vat_lines: mappingResult.vat_lines.filter((l) => !isReverseChargeBasisLeg(l.account_number)),
  }
}

/**
 * Apply an explicit account override to a category-derived MappingResult.
 *
 * Same semantics as the v1 REST categorize route (app/api/v1/.../categorize):
 * the override replaces the business side of the mapping (debit when money
 * goes out, credit when money comes in) AFTER the settlement account has been
 * applied, so callers can book on company-custom accounts (e.g. VMB accounts)
 * that the fixed category → account maps cannot reach.
 *
 * The account must exist AND be active in the company's chart_of_accounts.
 * Unlike voucher lines, an override is never BAS-backfilled: the category
 * mapping's own account is the safe default when the override is wrong, so an
 * unknown number is a caller error, not a seeding opportunity.
 *
 * VAT lines survive an override only when the caller stated its VAT intent
 * explicitly (`vatExplicit`: a vat_treatment or vat_amount was passed).
 * Without it the override books GROSS with no auto-VAT line: the category
 * default (standard_25) was derived for the category's default account, and
 * carrying it onto an arbitrary override account fabricates a moms deduction
 * the caller never asked for. The flagship case is margin-scheme (VMB)
 * accounts in class 3/4, where input VAT is not deductible at all
 * (ML 2023:200): forgetting the treatment must under-deduct, never
 * over-deduct. Overrides onto a balance-sheet class 2 account drop the
 * auto-VAT lines even when explicit, EXCEPT the moms-line range 2610-2649
 * where posting VAT is the point (2650 momsredovisningskonto and 2690
 * diverse are class 2 but not moms-line accounts; auto-VAT there would
 * double-post).
 *
 * Throws on unknown/inactive account or a degenerate same-account entry; the
 * message is Swedish and actionable for both the agent and the approval UI.
 */
export async function applyAccountOverride(
  supabase: SupabaseClient,
  companyId: string,
  accountOverride: string,
  transactionAmount: number,
  mappingResult: MappingResult,
  vatExplicit: boolean,
): Promise<MappingResult> {
  const { data: account, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number, account_class, is_active, default_vat_treatment')
    .eq('company_id', companyId)
    .eq('account_number', accountOverride)
    .maybeSingle()

  if (error) {
    throw new Error(`Database error: ${error.message}`)
  }
  if (!account) {
    throw unusableOverride(
      `Konto ${accountOverride} finns inte i kontoplanen: account_override kräver ett befintligt aktivt konto. ` +
      'Skapa det först (gnubok_create_account) eller välj ett annat konto.',
    )
  }
  if (!account.is_active) {
    throw unusableOverride(
      `Konto ${accountOverride} är inaktivt i kontoplanen. ` +
      'Aktivera det först (gnubok_update_account med is_active=true) eller välj ett annat konto.',
    )
  }

  if (transactionAmount < 0) {
    mappingResult.debit_account = accountOverride
  } else {
    mappingResult.credit_account = accountOverride
  }

  if (mappingResult.debit_account === mappingResult.credit_account) {
    throw new Error(
      `account_override ${accountOverride} är samma konto som motkontot: ` +
      'verifikatet skulle debitera och kreditera samma konto. Välj ett annat konto.',
    )
  }

  const overrideNum = parseInt(accountOverride, 10)
  const isMomsLineAccount = overrideNum >= 2610 && overrideNum <= 2649
  if (!vatExplicit || (account.account_class === 2 && !isMomsLineAccount)) {
    mappingResult.vat_lines = []
  }

  return reconcileRcBasisWithCostAccount(
    mappingResult,
    transactionAmount,
    accountOverride,
    account.default_vat_treatment ?? null,
  )
}

/**
 * An override account the chart cannot take (missing or inactive), coded
 * TX_CATEGORIZE_INVALID_ACCOUNT as the v1 categorize route answers for the
 * same argument; uncoded, an MCP agent got UNKNOWN_ERROR and retry advice.
 * The text stays Swedish: the approval commit shows it to the user as is.
 */
function unusableOverride(message: string): Error {
  return Object.assign(new Error(message), { code: 'TX_CATEGORIZE_INVALID_ACCOUNT' })
}
