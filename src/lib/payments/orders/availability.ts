/**
 * Whether a company can pay through the bank right now, from which of its
 * accounts, and whether the provider has verified the company (know your
 * customer): what the payment dialog needs before it offers anything.
 */

import { hasSignerOnFile } from '@/lib/auth/bankid-signer'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import {
  getPaymentInitiationProvider,
  PaymentProviderError,
  type PaymentInitiationProvider,
  type PaymentPartyContext,
} from '@/lib/payments/initiation/provider'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { createServiceClient } from '@/lib/supabase/server'
import { resolveDebtor, type DebtorResolution } from './debtor'
import { openPaymentsDoor, type PaymentsUnavailableReason } from './switched-on'
import {
  readVerificationRecord,
  recordVerificationCheck,
  recordVerificationLink,
  verificationNeedsRefresh,
  type VerificationRecord,
} from './verification-record'
import { deriveVerificationState, verificationLinkExpiresAt, type DerivedVerification, type VerificationState } from './verification-state'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

/** The company as the provider's KYC endpoints address it: by its organisationsnummer, in the corporate context. */
export async function companyParty(ctx: Pick<OperationContext, 'supabase' | 'companyId'>): Promise<PaymentPartyContext | null> {
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

/**
 * The company's verification as every surface shows it: the provider's
 * status and date, the derived state (verification-state.ts) and the current
 * form link's expiry. Never the form URL.
 */
export interface CompanyVerificationView {
  status: DerivedVerification['status']
  valid_until: string | null
  state: VerificationState
  /** ISO instant the current form link runs out (24 h after it was created); null without a link. */
  link_expires_at: string | null
  /** When the provider was last asked; null when it never answered. */
  checked_at: string | null
}

function toView(record: VerificationRecord | null, now: Date): CompanyVerificationView {
  const derived = deriveVerificationState(record, now)
  return {
    status: derived.status,
    valid_until: derived.valid_until,
    state: derived.state,
    link_expires_at: derived.link_expires_at,
    checked_at: record?.checked_at ?? null,
  }
}

function providerFailure(error: unknown): Extract<OperationOutcome<never>, { ok: false }> {
  const retryable = error instanceof PaymentProviderError && error.retryable
  return { ok: false, code: retryable ? 'PAYMENT_PROVIDER_UNAVAILABLE' : 'PAYMENT_PROVIDER_REFUSED' }
}

/**
 * Ask the provider and store the answer. Shared by the reads below and the
 * cron sweep (verification-sweep.ts). Throws what the provider threw.
 */
export async function refreshCompanyVerification(
  writer: Parameters<typeof recordVerificationCheck>[0],
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  now: Date = new Date(),
): Promise<void> {
  const verification = await provider.getCompanyVerification(party)
  await recordVerificationCheck(writer, party.companyId, { status: verification.status, validUntil: verification.validUntil, checkedAt: now })
}

export interface VerificationReadOptions {
  /** Ask the provider even when the stored answer is fresh (the dialog's poll while a form is open). */
  refresh?: boolean
  now?: Date
}

/**
 * Where the company's verification stands. The stored record answers when it
 * is fresh (verificationNeedsRefresh: six hours, unless a form is out or the
 * caller asks); otherwise the provider is asked and the record updated. A
 * provider that does not answer leaves the last known record to speak; only
 * with nothing on file is its failure the answer.
 */
export async function getCompanyPaymentVerification(
  ctx: OperationContext,
  options: VerificationReadOptions = {},
): Promise<OperationOutcome<CompanyVerificationView>> {
  const door = await openPaymentsDoor(ctx)
  if (!door.ok) return { ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: door.reason } }
  const provider = door.provider
  const party = await companyParty(ctx)
  if (!party) return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'org_number', reason: 'missing' } }
  const now = options.now ?? new Date()
  // The stored record is a cache of the provider's answer: a store that
  // cannot be read or written never stands between the caller and the answer.
  let writer: ReturnType<typeof createServiceClient> | null = null
  let record: VerificationRecord | null = null
  try {
    writer = createServiceClient()
    record = await readVerificationRecord(writer, ctx.companyId)
  } catch (error) {
    ctx.log.warn('payments verification record not read; asking the provider', { error: error instanceof Error ? error.message : String(error) })
  }
  if (!verificationNeedsRefresh(record, now, options.refresh === true)) return { ok: true, data: toView(record, now) }
  let answer: Awaited<ReturnType<PaymentInitiationProvider['getCompanyVerification']>>
  try {
    answer = await provider.getCompanyVerification(party)
  } catch (error) {
    if (!record) return providerFailure(error)
    ctx.log.warn('payments verification not refreshed; answering the stored record', {
      code: error instanceof PaymentProviderError ? error.code : 'UNEXPECTED_ERROR',
    })
    return { ok: true, data: toView(record, now) }
  }
  const check = { status: answer.status, validUntil: answer.validUntil, checkedAt: now }
  if (writer) {
    try {
      await recordVerificationCheck(writer, ctx.companyId, check)
    } catch (error) {
      ctx.log.warn('payments verification record not stored', { error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok: true, data: toView(withCheck(record, ctx.companyId, check), now) }
}

/** The record as it reads once the provider's answer is in: the link fields stay, the answer replaces the status. */
function withCheck(record: VerificationRecord | null, companyId: string, check: { status: VerificationRecord['status']; validUntil: string | null; checkedAt: Date }): VerificationRecord {
  const checkedAt = check.checkedAt.toISOString()
  return {
    company_id: companyId,
    link_created_at: null,
    link_expires_at: null,
    handed_off_at: null,
    started_by: null,
    updated_at: checkedAt,
    ...record,
    status: check.status,
    valid_until: check.validUntil,
    checked_at: checkedAt,
  }
}

export interface VerificationStartOptions {
  /** The link goes to a firmatecknare (mailed or copied for them), not to the person at the screen: the state reads awaiting_signatory. */
  handoff?: boolean
  now?: Date
}

export interface StartedCompanyVerification {
  /** The hosted form. Shown or handed to a person once; never stored by the caller, never logged. */
  url: string
  /** ISO instant the form link runs out (24 hours). */
  expires_at: string
  state: VerificationState
}

/**
 * Create a verification form at the provider and remember the link: the
 * state is then form_open (or awaiting_signatory with handoff) until the
 * provider answers valid or the 24 hours pass.
 */
export async function startCompanyPaymentVerification(
  ctx: OperationContext,
  options: VerificationStartOptions = {},
): Promise<OperationOutcome<StartedCompanyVerification>> {
  const door = await openPaymentsDoor(ctx)
  if (!door.ok) return { ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: door.reason } }
  const provider = door.provider
  const party = await companyParty(ctx)
  if (!party) return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'org_number', reason: 'missing' } }
  const now = options.now ?? new Date()
  let url: string
  try {
    url = (await provider.startCompanyVerification(party)).url
  } catch (error) {
    return providerFailure(error)
  }
  // The form exists at the provider now: the person gets its link even when
  // the record cannot be read or written, and the state is derived from the
  // link just created, never from a read-back of an older one.
  const handedOff = options.handoff === true
  const expiresAt = verificationLinkExpiresAt(now)
  let prior: VerificationRecord | null = null
  try {
    const writer = createServiceClient()
    prior = await readVerificationRecord(writer, ctx.companyId)
    await recordVerificationLink(writer, ctx.companyId, {
      url,
      createdAt: now,
      // started_by references auth.users: a machine door's placeholder actor is not a person.
      startedBy: UUID_RE.test(ctx.userId) ? ctx.userId : null,
      handedOff,
    })
  } catch (error) {
    ctx.log.warn('payments verification link not stored', { error: error instanceof Error ? error.message : String(error) })
  }
  const createdAt = now.toISOString()
  const state = deriveVerificationState(
    {
      status: prior?.status ?? 'unknown',
      valid_until: prior?.valid_until ?? null,
      link_created_at: createdAt,
      link_expires_at: expiresAt,
      handed_off_at: handedOff ? createdAt : null,
    },
    now,
  ).state
  return { ok: true, data: { url, expires_at: expiresAt, state } }
}
