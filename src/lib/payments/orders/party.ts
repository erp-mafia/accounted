/**
 * Who pays and who signs: the PaymentPartyContext every provider call needs.
 * The signer's personnummer comes from lib/auth/bankid-signer.ts and is never
 * stored on the order or logged. A call to payments that already exist at the
 * bank sends the number they were created with (payment_batch_psus,
 * lib/auth/resource-psu.ts): several banks require the same PSU-ID on every
 * later call to a payment, its status in a decoupled flow included.
 */

import { normalizeSignerPersonalNumber, signerPersonalNumberOnFile } from '@/lib/auth/bankid-signer'
import { storedBatchPsu } from '@/lib/auth/resource-psu'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { psuAuthoriserIdFor } from '@/lib/bank-feed/psu-authoriser'
import type { PaymentPartyContext } from '@/lib/payments/initiation/provider'
import { paymentAccountContext, type DebtorSnapshot } from './debtor'

export interface SignerInput {
  /** Typed in the signing dialog; used when the person has no BankID login on file. */
  personalNumber: string | null
  ipAddress: string | null
  userAgent: string | null
  /**
   * Whether the number on file for the context's user may stand in when none
   * was typed, and be remembered for them after a signing start. True (the
   * default) for a session: the person signs for themselves. False on the
   * payment signing link (lib/payments/orders/signing-link-route.ts): the
   * context's user is the sender, whose number must never name the
   * firmatecknare's BankID, and the firmatecknare's number is never kept.
   */
  lookupOnFile?: boolean
  /** Typed in the signing dialog for Nordea Corporate Netbank; sent with a Nordea signing only, never stored. */
  psuAuthoriserId?: string | null
}

/** The company's organisationsnummer as stored: the settings row first, the company row as fallback; null when neither has one. */
export async function companyOrgNumber(ctx: Pick<OperationContext, 'supabase' | 'companyId'>): Promise<string | null> {
  const { data: settings } = await ctx.supabase
    .from('company_settings')
    .select('org_number')
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  const fromSettings = (settings as { org_number?: string | null } | null)?.org_number ?? null
  if (fromSettings) return fromSettings
  const { data: company } = await ctx.supabase.from('companies').select('org_number').eq('id', ctx.companyId).maybeSingle()
  return (company as { org_number?: string | null } | null)?.org_number ?? null
}

export async function buildPartyContext(
  ctx: OperationContext,
  order: { debtor_snapshot: DebtorSnapshot },
  signer: SignerInput,
  options: {
    requireSigner?: boolean
    /** The signing whose payments the call reaches: the PSU-ID they were created with leads, before the typed number or the one on file. */
    batchId?: string | null
  } = {},
): Promise<{ ok: true; ctx: PaymentPartyContext; storedPsu: boolean } | { ok: false; outcome: OperationOutcome<never> }> {
  const orgNumber = await companyOrgNumber(ctx)
  if (!orgNumber) return { ok: false, outcome: { ok: false, code: 'VALIDATION_ERROR', details: { field: 'org_number', reason: 'missing' } } }

  const typed = normalizeSignerPersonalNumber(signer.personalNumber)
  if (signer.personalNumber && !typed) {
    return { ok: false, outcome: { ok: false, code: 'PAYMENT_SIGNER_PERSONAL_NUMBER_REQUIRED', details: { reason: 'invalid' } } }
  }
  const stored = options.batchId ? await storedBatchPsu(options.batchId) : null
  const personalNumber = stored ?? typed ?? (signer.lookupOnFile === false ? null : await signerPersonalNumberOnFile(ctx.userId))
  if (options.requireSigner && !personalNumber) {
    return { ok: false, outcome: { ok: false, code: 'PAYMENT_SIGNER_PERSONAL_NUMBER_REQUIRED' } }
  }
  const authoriser = psuAuthoriserIdFor(order.debtor_snapshot.bic, signer.psuAuthoriserId)
  if (!authoriser.ok) return { ok: false, outcome: { ok: false, code: 'VALIDATION_ERROR', details: { field: 'psu_authoriser_id', reason: 'invalid' } } }

  return {
    ok: true,
    storedPsu: stored !== null,
    ctx: {
      companyId: ctx.companyId,
      companyOrgNumber: orgNumber,
      accountContext: paymentAccountContext(order.debtor_snapshot.psu_type),
      debtorBic: order.debtor_snapshot.bic,
      affiliatedAspspId: order.debtor_snapshot.affiliated_aspsp_id ?? null,
      signerPersonalNumber: personalNumber,
      psuIpAddress: signer.ipAddress,
      psuUserAgent: signer.userAgent,
      ...(authoriser.value ? { psuAuthoriserId: authoriser.value } : {}),
    },
  }
}
