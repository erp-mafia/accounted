/**
 * Whether a company can pay through the bank right now, from which of its
 * accounts, and whether the provider has verified the company (know your
 * customer): what the payment dialog needs before it offers anything.
 */

import { hasSignerOnFile } from '@/lib/auth/bankid-signer'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { getPaymentInitiationProvider, PaymentProviderError, type PaymentPartyContext } from '@/lib/payments/initiation/provider'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { resolveDebtor, type DebtorResolution } from './debtor'
import { openPaymentsDoor, type PaymentsUnavailableReason } from './switched-on'

export interface PayableAccount {
  id: string
  name: string | null
  ledger_account: string
  iban: string | null
  /** The bank behind the account, as its connection reports it; the mark and the signing step name it. */
  bank_name: string | null
  payable: boolean
  reason: Exclude<DebtorResolution, { ok: true }>['reason'] | null
}

export interface PaymentsAvailability {
  available: boolean
  /** Why not, when available is false: no provider on this installation, a sandbox company, or no paid plan. */
  reason: PaymentsUnavailableReason | null
  provider: string | null
  accounts: PayableAccount[]
  /** The person has a BankID login on file, so signing needs no typed personnummer. Never the number itself. */
  signer_known: boolean
}

export async function getPaymentsAvailability(ctx: OperationContext): Promise<PaymentsAvailability> {
  const unavailable = (reason: PaymentsUnavailableReason): PaymentsAvailability => ({ available: false, reason, provider: null, accounts: [], signer_known: false })
  if (!(await getPaymentInitiationProvider(ctx.companyId))) return unavailable('no_provider')
  // Sandbox before the plan: a demo visitor is refused, never upsold.
  if (await isSandboxCompany(ctx.supabase, ctx.companyId)) return unavailable('sandbox')
  const door = await openPaymentsDoor(ctx)
  if (!door.ok) return unavailable(door.reason)
  const provider = door.provider
  const { data, error } = await ctx.supabase
    .from('cash_accounts')
    .select('id, name, ledger_account, iban, currency, enabled, bank_connection:bank_connections(bank_name, affiliated_aspsp_id, psu_type)')
    .eq('company_id', ctx.companyId)
    .order('ledger_account', { ascending: true })
  if (error) throw error
  const accounts = ((data ?? []) as unknown as Array<{
    id: string
    name: string | null
    ledger_account: string
    iban: string | null
    currency: string
    enabled: boolean
    bank_connection: { bank_name: string | null; affiliated_aspsp_id: string | null; psu_type: string | null } | null
  }>).map((a) => {
    const debtor = resolveDebtor(a, a.bank_connection)
    return {
      id: a.id,
      name: a.name,
      ledger_account: a.ledger_account,
      iban: a.iban,
      bank_name: a.bank_connection?.bank_name ?? null,
      payable: debtor.ok,
      reason: debtor.ok ? null : debtor.reason,
    }
  })
  return { available: true, reason: null, provider: provider.id, accounts, signer_known: await hasSignerOnFile(ctx.userId) }
}

async function companyParty(ctx: OperationContext): Promise<PaymentPartyContext | null> {
  const { data: settings } = await ctx.supabase.from('company_settings').select('org_number').eq('company_id', ctx.companyId).maybeSingle()
  let orgNumber = (settings as { org_number?: string | null } | null)?.org_number ?? null
  if (!orgNumber) {
    const { data: company } = await ctx.supabase.from('companies').select('org_number').eq('id', ctx.companyId).maybeSingle()
    orgNumber = (company as { org_number?: string | null } | null)?.org_number ?? null
  }
  if (!orgNumber) return null
  return {
    companyId: ctx.companyId,
    companyOrgNumber: orgNumber,
    accountContext: 'corporate',
    debtorBic: '',
    affiliatedAspspId: null,
    signerPersonalNumber: null,
    psuIpAddress: null,
    psuUserAgent: null,
  }
}

export async function getCompanyPaymentVerification(
  ctx: OperationContext,
): Promise<OperationOutcome<{ status: 'valid' | 'invalid' | 'unknown'; valid_until: string | null }>> {
  const door = await openPaymentsDoor(ctx)
  if (!door.ok) return { ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: door.reason } }
  const provider = door.provider
  const party = await companyParty(ctx)
  if (!party) return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'org_number', reason: 'missing' } }
  try {
    const verification = await provider.getCompanyVerification(party)
    return { ok: true, data: { status: verification.status, valid_until: verification.validUntil } }
  } catch (error) {
    const retryable = error instanceof PaymentProviderError && error.retryable
    return { ok: false, code: retryable ? 'PAYMENT_PROVIDER_UNAVAILABLE' : 'PAYMENT_PROVIDER_REFUSED' }
  }
}

export async function startCompanyPaymentVerification(ctx: OperationContext): Promise<OperationOutcome<{ url: string }>> {
  const door = await openPaymentsDoor(ctx)
  if (!door.ok) return { ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: door.reason } }
  const provider = door.provider
  const party = await companyParty(ctx)
  if (!party) return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'org_number', reason: 'missing' } }
  try {
    const started = await provider.startCompanyVerification(party)
    return { ok: true, data: { url: started.url } }
  } catch (error) {
    const retryable = error instanceof PaymentProviderError && error.retryable
    return { ok: false, code: retryable ? 'PAYMENT_PROVIDER_UNAVAILABLE' : 'PAYMENT_PROVIDER_REFUSED' }
  }
}
