/**
 * The verifikat approving a staged proposal would post, worked out now with
 * the code the approval posts through, and nothing written. For a proposal
 * whose rows are built at the click (verifikatBuiltAtApproval): a supplier
 * invoice from the inbox runs the approval's own conversion as a dry run
 * (stagedConversion, then convertInboxItemToSupplierInvoice), which builds
 * the registration verifikat over the invoice the approval would insert. A
 * refusal is the approval's own.
 *
 * Worked out when asked, never stored on the proposal: the company's
 * settings, the supplier, its momskoder and the fiscal years may change
 * between the staging and the click, and the approval reads them at the click.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { convertInboxItemToSupplierInvoice, stagedConversion } from '@/lib/operations/inbox-convert'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { ApprovalVerifikatAnswer, BuiltVerifikat } from './built-at-approval'

type Refusal = Pick<Extract<OperationOutcome<never>, { ok: false }>, 'details' | 'messageSv' | 'messageEn' | 'error'>

/** A refusal in both languages, as the approval would say it. */
function refused(code: string, refusal: Refusal): ApprovalVerifikatAnswer {
  // A BookkeepingError (an account the chart refuses) reaches the person as the engine's own refusal.
  const thrown = isBookkeepingError(refusal.error) ? (refusal.error as Error & { code: string }) : null
  const entry = getErrorEntry(code)
  const said = thrown ?? {
    error: {
      code,
      message: refusal.messageSv ?? entry?.message_sv ?? code,
      message_en: refusal.messageEn ?? entry?.message_en,
      details: refusal.details,
    },
  }
  return {
    posts: 'refused',
    code: thrown?.code ?? code,
    message_sv: getErrorMessage(said, { locale: 'sv' }),
    message_en: getErrorMessage(said, { locale: 'en' }),
  }
}

/**
 * What approving the staged supplier invoice from the inbox would post now:
 * its registration verifikat, nothing (kontantmetoden, deferred booking),
 * rows known only at the click (a rate the approval fetches), or the
 * approval's refusal. `params` are the proposal's staged params.
 */
export async function approvalVerifikat(
  ctx: OperationContext,
  params: Record<string, unknown>,
): Promise<ApprovalVerifikatAnswer> {
  const staged = stagedConversion(params)
  if (!staged.ok) return refused(staged.code ?? 'SI_CREATE_INVALID_INPUT', {})
  // Staged in another currency without a rate: the approval asks Riksbanken
  // for it and keeps the answer in the shared rate cache. A preview that did
  // the same would write, and call Riksbanken on a hover.
  if (!isLedgerCurrency(staged.body.currency) && staged.body.exchange_rate === undefined) return { posts: 'at_approval' }
  const outcome = await convertInboxItemToSupplierInvoice(ctx, staged.inboxItemId, staged.body, {
    dryRun: true,
    approvedTotal: staged.approvedTotal,
    withVerifikat: true,
  })
  if (!outcome.ok) return refused(outcome.code, outcome)
  if (!outcome.dryRun) throw new Error('the conversion answered a commit to a dry run')
  const verifikat = outcome.preview.verifikat as BuiltVerifikat | null | undefined
  return verifikat ? { posts: 'verifikat', verifikat: [verifikat] } : { posts: 'nothing' }
}
