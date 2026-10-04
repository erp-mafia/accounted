/**
 * Who pays and who signs: the PaymentPartyContext every provider call needs.
 * The signer's personnummer comes from lib/auth/bankid-signer.ts and is never
 * stored on the order or logged.
 */

import { normalizeSignerPersonalNumber, signerPersonalNumberFromBankIdLogin } from '@/lib/auth/bankid-signer'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { PaymentPartyContext } from '@/lib/payments/initiation/provider'
import type { DebtorSnapshot } from './debtor'

export interface SignerInput {
  /** Typed in the signing dialog; used when the person has no BankID login on file. */
  personalNumber: string | null
  ipAddress: string | null
  userAgent: string | null
}

export async function buildPartyContext(
  ctx: OperationContext,
  order: { debtor_snapshot: DebtorSnapshot },
  signer: SignerInput,
  options: { requireSigner?: boolean } = {},
): Promise<{ ok: true; ctx: PaymentPartyContext } | { ok: false; outcome: OperationOutcome<never> }> {
  const { data: settings } = await ctx.supabase
    .from('company_settings')
    .select('org_number')
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  let orgNumber = (settings as { org_number?: string | null } | null)?.org_number ?? null
  if (!orgNumber) {
    const { data: company } = await ctx.supabase.from('companies').select('org_number').eq('id', ctx.companyId).maybeSingle()
    orgNumber = (company as { org_number?: string | null } | null)?.org_number ?? null
  }
  if (!orgNumber) return { ok: false, outcome: { ok: false, code: 'VALIDATION_ERROR', details: { field: 'org_number', reason: 'missing' } } }

  const typed = normalizeSignerPersonalNumber(signer.personalNumber)
  if (signer.personalNumber && !typed) {
    return { ok: false, outcome: { ok: false, code: 'PAYMENT_SIGNER_PERSONAL_NUMBER_REQUIRED', details: { reason: 'invalid' } } }
  }
  const personalNumber = typed ?? (await signerPersonalNumberFromBankIdLogin(ctx.userId))
  if (options.requireSigner && !personalNumber) {
    return { ok: false, outcome: { ok: false, code: 'PAYMENT_SIGNER_PERSONAL_NUMBER_REQUIRED' } }
  }

  return {
    ok: true,
    ctx: {
      companyId: ctx.companyId,
      companyOrgNumber: orgNumber,
      accountContext: 'corporate',
      debtorBic: order.debtor_snapshot.bic,
      signerPersonalNumber: personalNumber,
      psuIpAddress: signer.ipAddress,
      psuUserAgent: signer.userAgent,
    },
  }
}
