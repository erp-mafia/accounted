/**
 * Connecting a bank with BankID through Open Payments (Connect's AIS family),
 * and keeping that connection: the service behind the operations in
 * lib/operations/bank-feed.ts and the session routes under
 * /api/bank/open-payments.
 *
 *   start      the consent is created at the bank and BankID started; the
 *              attempt is a 'pending' bank_connections row (aggregator
 *              open_payments, provider 'open_payments', bic, the consent id in
 *              session_id, the authorisation in authorization_id, everything
 *              else about the attempt in consent_attempt), so poll and
 *              restart take no body and a person can resume from Kopplingar.
 *              A bank that signs on its own page (redirect) gets the entry
 *              point's return URL (lib/bank-feed/return-url.ts) and answers
 *              the bank's page in the challenge; the browser comes back with
 *              the connection named and polls as for decoupled;
 *   poll       fresh BankID data while pending; a valid consent's accounts
 *              are read and finalize_open_payments_consent makes the row
 *              await account selection (superseding older Open Payments rows
 *              for the bank and adopting the Enable Banking dedup scope);
 *              Svea's second consent (naming the chosen accounts) goes
 *              straight to active with the selection saved earlier;
 *   restart    a new BankID authorisation for the same consent (a new consent
 *              when the bank says the first is over);
 *   select     the same account selection every bank feed uses
 *              (resolvePsd2LedgerAccount, save_bank_account_selection), the
 *              Enable Banking rows it takes over handed over (the one a
 *              switch named, and any reading only accounts this connection
 *              now reads: ./handover.ts), then the
 *              first import inline; Svea gets its second consent instead,
 *              started as the first was (the bank's page with the entry
 *              point's return when that is how the bank signs), the listing
 *              consent ended once the second is valid;
 *   sync       "Synka nu": one read with the person present;
 *   disconnect the shared disconnect RPC, then the consent ended at the bank
 *              under the revocation claim of the 'openpayments' namespace; a
 *              consent the bank did not end stays named on the removed row.
 *
 * Connect counts one bank connection per company: a consent holds the place
 * until it is ended. When it refuses a new consent over that, start ends the
 * consents the company no longer needs (the one a renewal replaces, and the
 * removed rows' unended ones) and asks once more.
 *
 * The signer's personnummer comes from their BankID login or the number they
 * typed; it is sent to the bank and never logged. The number a consent was
 * created with is kept encrypted (bank_connection_psus,
 * lib/auth/resource-psu.ts) and sent on every later call to that consent:
 * several banks require the same PSU-ID throughout. A co-signer's own
 * authorisation on a partly signed consent carries the co-signer's number
 * and never replaces the kept one.
 */

import type { AisAccount, AisBankDetails, AisConsentSigningProgress, AisConsentSigningStarted, AisParty } from '@accounted/connect-contract'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasSignerOnFile } from '@/lib/auth/bankid-signer'
import { rememberConnectionPsu, type ConnectionPsuSource } from '@/lib/auth/resource-psu'
import { isEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { aggregatorOf, AGGREGATOR_SESSION_NAMESPACE, LIVE_CONNECTION_STATUSES, OPEN_PAYMENTS_AGGREGATOR, OPEN_PAYMENTS_PROVIDER_SLUG } from '@/lib/bank-sync/aggregator'
import { disconnectBankConnection, readBankConfiguration, saveBankAccountSelection, type BankAccountSelection } from '@/lib/cash-accounts/configuration'
import { resolvePsd2LedgerAccount } from '@/lib/cash-accounts/service'
import { endOfDayIsoStockholm } from '@/lib/dates/iso'
import { hasErrorEntry } from '@/lib/errors/structured-errors'
import { eventBus } from '@/lib/events/bus'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { SigningChallenge } from '@/lib/payments/initiation/provider'
import { createServiceClient } from '@/lib/supabase/server'
import type { TriggerSyncResult } from '@/lib/bank-sync/trigger-sync-contract'
import { bankCoveredByOpenPayments } from './bank-coverage'
import { BANK_FEED_NOT_FOUND, BankFeedError, BankFeedRefusedError, ConsentOverError, getBankFeedConnect, type BankFeedConnect } from './connect'
import { openBankFeedDoor, reachesUncoveredBanks } from './door'
import { consentFailureText, OPEN_BANKING_FAILURE_TEXTS } from './failure-text'
import { runOpenPaymentsSync } from './feed'
import { enableBankingRowsTakenOver, type HandoverCandidate } from './handover'
import { accountContextOf, buildBankFeedParty, psuTypeOf, UNATTENDED_SIGNER, type BankFeedSignerInput, type PsuType } from './party'
import { BANK_CONNECT_SIGNATORY_TARGET, bankConnectReturnUrl, type BankConnectReturnTarget } from './return-url'
import { viaCanonicalOrigin } from '@/lib/connect/return-bounce'
import { getCanonicalAppOrigin } from '@/lib/domains/trusted-app-origin'
import { normalizeIban, type BankFeedAccount } from './sync'

/** BankID in our screen (same_device, qr) or on the bank's own page (redirect). */
export type ConsentMethod = 'same_device' | 'qr' | 'redirect'
export type ConsentStep = 'identify' | 'consent' | null

/** The BankID attempt in flight, as the browser renders it. */
export interface AttemptView {
  authorisation_id: string | null
  method: ConsentMethod
  state: 'pending' | 'failed' | 'partially_authorised'
  challenge: SigningChallenge | null
  sca_status: string | null
  step: ConsentStep
  failure_code: string | null
  failure_text: string | null
}

export interface StartView {
  connection_id: string
  attempt: AttemptView
}

/** One account the consent reaches, with the ledger it would get. */
export interface ConsentAccountView {
  uid: string
  name: string | null
  iban: string | null
  bban: string | null
  currency: string
  usage: string | null
  /** The company's accounts (ORGA) start selected; the signer's own (PRIV) do not. */
  preselected: boolean
  enabled: boolean
  /** The BAS number a new account would get. */
  suggested_ledger_account: string | null
  /** The ledger of the cash account this company already books the same IBAN + currency on; null when none. */
  matches_existing: string | null
}

export interface PollView {
  connection_id: string
  state: 'pending' | 'valid' | 'partially_authorised' | 'failed'
  method: ConsentMethod
  challenge: SigningChallenge | null
  sca_status: string | null
  step: ConsentStep
  failure_code: string | null
  failure_text: string | null
  /** On valid, while the connection awaits account selection. */
  accounts?: ConsentAccountView[]
  consent_expires?: string | null
  /** Svea: the first consent only lists accounts; a second one naming the chosen ones follows. */
  needs_second_consent?: boolean
  /** The connection's status after this poll. */
  status: string
}

export interface ConnectionView {
  connection_id: string
  bank_name: string | null
  bic: string | null
  provider: string
  status: string
  consent_expires: string | null
  last_synced_at: string | null
  initial_sync_completed_at: string | null
  error_message: string | null
  accounts: Array<{ uid: string; name: string | null; iban: string | null; currency: string; enabled: boolean; ledger_account: string | null; usage: string | null }>
}

export interface OverviewView {
  available: boolean
  reason: 'no_connector' | 'not_in_pilot' | 'subscription' | null
  connections: ConnectionView[]
  /** The person has a personnummer on file (BankID login or remembered), so no typing is needed. Never the number itself. */
  signer_known: boolean
}

export interface SelectView {
  connection: ConnectionView
  /** The first import, when it finished inside the request; null when it runs on (sync_pending) or was not due. */
  sync: { imported: number; duplicates: number; from: string; to: string } | null
  sync_pending: boolean
  /** Svea: the second consent to sign; poll the connection again, then call sync. */
  attempt?: AttemptView
}

/** The consent is asked to last this long; the bank clamps it and validUntil comes back. */
export const CONSENT_DAYS = 180
/** A pending attempt older than this was abandoned, unless a second signatory is still to sign. */
export const STALE_ATTEMPT_MS = 60 * 60 * 1000
/**
 * How long the account selection waits for the first import before it
 * answers that the import runs on (sync_pending). A door that keeps the work
 * alive past its answer (keepAlive: the two select routes) answers after the
 * short wait: a two-year history with its matching passes ran up to four
 * minutes behind a spinner. A door without one is the only thing keeping the
 * import running, so it waits the long way.
 */
export const INITIAL_SYNC_ANSWER_MS = 20_000
export const INITIAL_SYNC_WAIT_MS = 240_000
/** Svea Bank lists accounts under a first consent and reads them under a second one naming them. */
export const SVEA_BIC = 'SVEASESS'
const LEDGER = /^19\d{2}$/
const MAX_ENABLED_ACCOUNTS = 50

/** What the row keeps about the attempt (bank_connections.consent_attempt). */
export interface ConsentAttempt {
  method?: ConsentMethod
  state?: 'pending' | 'failed' | 'partially_authorised'
  sca_status?: string | null
  failure_code?: string | null
  started_at?: string
  /** Svea: this consent only lists accounts. */
  listing_only?: boolean
  replace_connection_id?: string | null
  extended_history_days?: number | null
  /** Redirect: the entry point the browser comes back to, so a restart needs no body. */
  return_to?: BankConnectReturnTarget | null
  /** Svea: the listing consent, ended once the second consent (naming the chosen accounts) is valid. */
  listing_consent_id?: string | null
  /**
   * The consent is partly signed and a co-signer signs now: their own
   * BankID, so the signing calls carry their number, not the one the consent
   * was created with. Cleared when a new consent is created for the row.
   */
  co_signing?: boolean
  /**
   * A removed connection only: its consent, which the bank did not end when
   * the connection was removed. Connect counts it against the company's one
   * bank connection until it is ended, so the next attempt ends it first
   * (releaseHeldConsents); cleared once it is.
   */
  unended_consent_id?: string | null
  /** Kept through finalize for the selection step (listing_only, replace_connection_id, extended_history_days, and Svea's chosen accounts). */
  selection?: {
    listing_only?: boolean
    replace_connection_id?: string | null
    extended_history_days?: number | null
    accounts?: Array<{ uid: string; enabled: boolean; ledger_account: string | null }>
    method?: ConsentMethod
    return_to?: BankConnectReturnTarget | null
  }
}

type Row = {
  id: string
  company_id: string
  user_id: string
  status: string
  aggregator?: string | null
  provider: string
  bic: string | null
  affiliated_aspsp_id: string | null
  psu_type: string | null
  bank_name: string | null
  session_id: string | null
  authorization_id: string | null
  consent_expires: string | null
  last_synced_at: string | null
  initial_sync_completed_at: string | null
  error_message: string | null
  accounts_data: BankFeedAccount[] | null
  consent_attempt: ConsentAttempt | null
}

const ROW_COLUMNS =
  'id, company_id, user_id, status, aggregator, provider, bic, affiliated_aspsp_id, psu_type, bank_name, session_id, authorization_id, consent_expires, last_synced_at, initial_sync_completed_at, error_message, accounts_data, consent_attempt'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** Connect's refusal when the company already holds its one bank connection (or an attempt in progress). */
const CONNECTOR_QUOTA_EXCEEDED = 'CONNECTOR_QUOTA_EXCEEDED'

function isQuotaRefusal(error: unknown): boolean {
  return error instanceof BankFeedError && error.code === CONNECTOR_QUOTA_EXCEEDED
}

function providerFailure(error: unknown, log?: Pick<OperationContext['log'], 'warn'>): Failure {
  if (error instanceof ConsentOverError) return { ok: false, code: 'BANK_CONSENT_OVER', details: { provider_code: error.providerCode } }
  if (error instanceof BankFeedError) {
    if (error.code === BANK_FEED_NOT_FOUND) return { ok: false, code: 'BANK_CONSENT_CHANGED', details: { provider_code: error.providerCode } }
    // One bank connection per company: another connection, or an attempt
    // still in progress, holds the place. Not the bank's refusal.
    if (error.code === CONNECTOR_QUOTA_EXCEEDED) return { ok: false, code: 'BANK_CONNECTION_IN_PROGRESS' }
    // The bank's own code reaches the log: the response names it only in
    // details, and the route logs the generic refusal.
    log?.warn('bank provider refused', { code: error.code, provider_code: error.providerCode, status: error.status, retryable: error.retryable })
    // A code the provider has a sentence for is that sentence on screen
    // (Nordea Corporate Netbank's missing logon id, Handelsbanken's missing
    // third-party access, a mismatched agreement, ...): most are fixed by the
    // person at the bank, which the generic refusal never tells them.
    const known = error.providerCode ? OPEN_BANKING_FAILURE_TEXTS[error.providerCode.trim().toUpperCase()] : undefined
    return {
      ok: false,
      code: error.retryable ? 'BANK_PROVIDER_UNAVAILABLE' : 'BANK_PROVIDER_REFUSED',
      details: { provider_code: error.providerCode ?? error.code, ...(error.providerCode ? { provider_text: consentFailureText(error.providerCode).sv } : {}) },
      ...(known ? { messageSv: known.sv } : {}),
    }
  }
  log?.warn('bank provider failed unexpectedly', { error: error instanceof Error ? error.message : String(error) })
  return { ok: false, code: 'BANK_PROVIDER_REFUSED', details: { provider_code: 'UNEXPECTED_ERROR' } }
}

/** A database refusal raised by name (the finalize, selection and supersede RPCs) keeps that name as its code. */
function databaseFailure(error: unknown): Failure {
  const message = (error as { message?: unknown } | null)?.message
  if (typeof message === 'string' && hasErrorEntry(message)) return { ok: false, code: message }
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && hasErrorEntry(code)) return { ok: false, code }
  if (code === 'P0002') return { ok: false, code: 'NOT_FOUND' }
  return { ok: false, code: 'INTERNAL_ERROR', error }
}

/**
 * Which BankID step the person is at, from the bank's SCA status as the
 * provider relays it: an identification first (authenticationStarted), then
 * the consent signing. Null when the status says neither.
 */
export function consentStep(scaStatus: string | null | undefined): ConsentStep {
  if (!scaStatus) return null
  if (/authentic|identif/i.test(scaStatus)) return 'identify'
  if (/authoris|started|sign|consent|scaMethodSelected/i.test(scaStatus)) return 'consent'
  return null
}

function toChallenge(challenge: AisConsentSigningStarted['challenge']): SigningChallenge | null {
  if (!challenge) return null
  return {
    approach: challenge.approach,
    autostartToken: challenge.autostartToken,
    qrData: challenge.qrData,
    qrImage: challenge.qrImage ?? null,
    redirectUrl: challenge.redirectUrl,
  }
}

function attemptView(
  method: ConsentMethod,
  authorisationId: string | null,
  progress: Pick<AisConsentSigningProgress, 'challenge' | 'failureCode' | 'scaStatus'> & { state: 'pending' | 'failed' | 'partially_authorised' },
): AttemptView {
  const failure = progress.state === 'failed' ? (progress.failureCode ?? 'SIGNING_UNSUCCESSFUL') : null
  return {
    authorisation_id: authorisationId,
    method,
    state: progress.state,
    challenge: progress.state === 'pending' ? toChallenge(progress.challenge) : null,
    sca_status: progress.scaStatus ?? null,
    step: progress.state === 'pending' ? consentStep(progress.scaStatus) : null,
    failure_code: failure,
    failure_text: failure ? consentFailureText(failure).sv : null,
  }
}

function connectionView(row: Row): ConnectionView {
  return {
    connection_id: row.id,
    bank_name: row.bank_name,
    bic: row.bic,
    provider: row.provider,
    status: row.status,
    consent_expires: row.consent_expires,
    last_synced_at: row.last_synced_at,
    initial_sync_completed_at: row.initial_sync_completed_at,
    error_message: row.error_message,
    accounts: (row.accounts_data ?? []).map((a) => ({
      uid: a.uid,
      name: a.name ?? null,
      iban: a.iban ?? null,
      currency: a.currency,
      enabled: a.enabled !== false,
      ledger_account: a.ledger_account ?? null,
      usage: a.usage ?? null,
    })),
  }
}

/** The consent grants access through its last day: the bank's day ends at midnight in Stockholm, not in UTC. */
function consentExpiresAt(validUntil: string): string {
  return endOfDayIsoStockholm(validUntil)
}

function validUntilRequested(now: number): string {
  return new Date(now + CONSENT_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * The consent's accounts as accounts_data entries. The company's accounts
 * (usage ORGA) start selected; the signer's own (PRIV) do not and keep only
 * what the picker shows (no balance, no owner name: accounts_data is readable
 * by every member of the company). When the bank reports no usage at all,
 * every account starts selected.
 */
export function toStoredAccounts(accounts: readonly AisAccount[], observedAt: string): Array<BankFeedAccount & { enabled: boolean }> {
  const anyUsage = accounts.some((a) => a.usage === 'ORGA' || a.usage === 'PRIV')
  return accounts.map((a) => {
    const enabled = anyUsage ? a.usage === 'ORGA' : true
    const entry: BankFeedAccount & { enabled: boolean } = { uid: a.uid, currency: a.currency.toUpperCase(), enabled }
    const iban = normalizeIban(a.iban)
    if (iban) entry.iban = iban
    if (a.bban) entry.bban = a.bban
    if (a.name) entry.name = a.name
    if (a.usage) entry.usage = a.usage
    if (!enabled) return entry
    if (a.balance !== null) {
      entry.balance = a.balance
      if (a.availableBalance !== null) entry.available_balance = a.availableBalance
      entry.balance_updated_at = observedAt
    }
    return entry
  })
}

async function loadRow(ctx: OperationContext, connectionId: string): Promise<Row | null> {
  const { data, error } = await ctx.supabase
    .from('bank_connections')
    .select(ROW_COLUMNS)
    .eq('id', connectionId)
    .eq('company_id', ctx.companyId)
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .maybeSingle()
  if (error) throw error
  return (data as Row | null) ?? null
}

/**
 * The party for a call to the row's consent: the PSU-ID the consent was
 * created with first (bank_connection_psus), else the typed number or the one
 * on file. coSigner: a co-signer's own authorisation, carrying their number.
 */
async function partyFor(
  ctx: OperationContext,
  row: Pick<Row, 'id' | 'bic' | 'affiliated_aspsp_id' | 'psu_type'>,
  signer: BankFeedSignerInput,
  requireSigner: boolean,
  options: { coSigner?: boolean } = {},
) {
  return buildBankFeedParty(ctx.supabase, {
    companyId: ctx.companyId,
    bic: row.bic ?? '',
    affiliatedAspspId: row.affiliated_aspsp_id,
    psuType: row.psu_type,
    signer,
    userId: ctx.userId,
    requireSigner,
    connectionId: row.id,
    coSigner: options.coSigner === true,
  })
}

/** Whether the row's attempt is a co-signer's: the consent was partly signed before this BankID. */
function isCoSigning(attempt: ConsentAttempt | null): boolean {
  return attempt?.state === 'partially_authorised' || attempt?.co_signing === true
}

/** Keep the number a consent for the row was just created with (a new consent overwrites). */
async function rememberConsentPsu(ctx: OperationContext, connectionId: string, party: { party: AisParty; source: ConnectionPsuSource | null }): Promise<void> {
  if (!party.party.personalNumber) return
  await rememberConnectionPsu({ connectionId, companyId: ctx.companyId, personalNumber: party.party.personalNumber, source: party.source ?? 'typed' })
}

async function writeAttempt(ctx: OperationContext, row: Row, patch: Record<string, unknown>): Promise<void> {
  const { error } = await ctx.supabase
    .from('bank_connections')
    .update(patch)
    .eq('id', row.id)
    .eq('company_id', ctx.companyId)
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
  if (error) throw error
}

// ---------------------------------------------------------------------------
// banks, overview
// ---------------------------------------------------------------------------

export interface BankView {
  bic: string
  name: string
  logo_url: string | null
  decoupled: boolean | null
  redirect: boolean | null
  /** Open Payments reaches the bank for this company: not on the coverage list (./bank-coverage.ts), or the company is in the pilot for those (reachesUncoveredBanks). */
  reached: boolean
}

export async function listBankFeedBanks(ctx: OperationContext): Promise<OperationOutcome<{ banks: BankView[] }>> {
  const door = await openBankFeedDoor(ctx)
  if (!door.ok) return { ok: false, code: 'OPEN_BANKING_NOT_AVAILABLE', details: { reason: door.reason } }
  try {
    const banks = await door.connect.banks(ctx.companyId)
    const pilot = reachesUncoveredBanks(ctx.companyId)
    return {
      ok: true,
      data: {
        banks: banks.map((b) => ({
          bic: b.bic, name: b.name, logo_url: b.logoUrl, decoupled: b.decoupled, redirect: b.redirect, reached: pilot || bankCoveredByOpenPayments(b.name),
        })),
      },
    }
  } catch (error) {
    return providerFailure(error, ctx.log)
  }
}

/** One bank's details as the flow needs them: how a person signs there, and the sparbanker behind a shared BIC. */
export interface BankDetailsView {
  bic: string
  name: string
  decoupled: boolean | null
  redirect: boolean | null
  affiliates: Array<{ id: string; name: string }>
  transaction_history_max_days: number | null
  extended_transaction_history_max_days: number | null
}

function bankDetailsView(bank: AisBankDetails): BankDetailsView {
  return {
    bic: bank.bic,
    name: bank.name,
    decoupled: bank.decoupled,
    redirect: bank.redirect,
    affiliates: bank.affiliates.map((a) => ({ id: a.id, name: a.name })),
    transaction_history_max_days: bank.transactionHistoryMaxDays,
    extended_transaction_history_max_days: bank.extendedTransactionHistoryMaxDays,
  }
}

export async function getBankFeedBankDetails(ctx: OperationContext, bic: string): Promise<OperationOutcome<BankDetailsView>> {
  const door = await openBankFeedDoor(ctx)
  if (!door.ok) return { ok: false, code: 'OPEN_BANKING_NOT_AVAILABLE', details: { reason: door.reason } }
  try {
    return { ok: true, data: bankDetailsView(await door.connect.getBankDetails(ctx.companyId, bic)) }
  } catch (error) {
    if (error instanceof BankFeedRefusedError && error.code === BANK_FEED_NOT_FOUND) return { ok: false, code: 'BANK_CONSENT_UNKNOWN_BANK' }
    return providerFailure(error, ctx.log)
  }
}

export async function getBankFeedOverview(ctx: OperationContext): Promise<OperationOutcome<OverviewView>> {
  const door = await openBankFeedDoor(ctx)
  const { data, error } = await ctx.supabase
    .from('bank_connections')
    .select(ROW_COLUMNS)
    .eq('company_id', ctx.companyId)
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .in('status', ['pending', 'pending_selection', 'active', 'error', 'expired'])
    .order('created_at', { ascending: false })
  if (error) throw error
  return {
    ok: true,
    data: {
      available: door.ok,
      reason: door.ok ? null : door.reason,
      connections: ((data ?? []) as Row[]).map(connectionView),
      signer_known: await hasSignerOnFile(ctx.userId),
    },
  }
}

// ---------------------------------------------------------------------------
// start, poll, restart
// ---------------------------------------------------------------------------

export interface StartInput {
  bic: string
  affiliatedAspspId?: string | null
  accountContext?: 'corporate' | 'private' | null
  method: ConsentMethod
  signer: BankFeedSignerInput
  /** The connection this one replaces: an Enable Banking row (switch, handed over at account selection) or an Open Payments row (renewal, superseded when the new consent is valid). */
  replaceConnectionId?: string | null
  /** Redirect: the entry point to come back to, and the app origin the request came to (the route resolves it). */
  returnTo?: BankConnectReturnTarget | null
  returnOrigin?: string | null
  /** The signatory page's link token: its return URL is built from it (the koppla target only). */
  returnToken?: string | null
  now?: number
}

/** What a renewal takes from the Open Payments row it replaces: the bank and the agreement the consent was granted under, and the consent it holds. */
interface RenewedConnection {
  id: string
  bic: string | null
  affiliated_aspsp_id: string | null
  bank_name: string | null
  psu_type: string | null
  /** The consent being replaced: ended when Connect needs the company's one place for the new one (releaseHeldConsents). */
  session_id: string | null
}

/** Where a redirect signing sends the browser back: the entry point, on the resolved app origin; the signatory page carries its link token. */
interface SigningReturn {
  surface: BankConnectReturnTarget
  origin: string
  token: string | null
}

function signingReturn(surface: BankConnectReturnTarget | null | undefined, origin: string | null | undefined, token?: string | null): SigningReturn | null {
  if (!surface || !origin) return null
  // The signatory page is reachable only through its link: without the token there is no page to come back to.
  if (surface === BANK_CONNECT_SIGNATORY_TARGET && !token) return null
  return { surface, origin, token: token ?? null }
}

const RETURN_REQUIRED: Failure = { ok: false, code: 'VALIDATION_ERROR', details: { field: 'return_to', reason: 'required_for_redirect' } }

async function startSigning(
  ctx: OperationContext,
  connect: BankFeedConnect,
  row: Row,
  party: AisParty,
  method: ConsentMethod,
  ret: SigningReturn | null,
  options: { coSigning?: boolean } = {},
): Promise<OperationOutcome<StartView>> {
  const coSigning = options.coSigning === true ? { co_signing: true } : {}
  if (method === 'redirect' && !ret) return RETURN_REQUIRED
  let started: AisConsentSigningStarted
  try {
    started = await connect.startConsentSigning(ctx.companyId, {
      party,
      consentId: row.session_id!,
      method,
      // Connect takes returns on the canonical origin only: a brand host's
      // return goes through the hop there (lib/connect/return-bounce.ts).
      ...(method === 'redirect' && ret
        ? { returnUrl: viaCanonicalOrigin(bankConnectReturnUrl(ret.origin, ret.surface, row.id, { token: ret.token }), getCanonicalAppOrigin()), returnState: row.id }
        : {}),
    })
  } catch (error) {
    return providerFailure(error, ctx.log)
  }
  // The bank imposed its own page on a start made for our screen: without a
  // return URL there is no way back, so the attempt is over.
  if (started.method === 'redirect' && method !== 'redirect') {
    await writeAttempt(ctx, row, {
      authorization_id: started.providerAuthorisationId,
      consent_attempt: { ...(row.consent_attempt ?? {}), ...coSigning, method, state: 'failed', sca_status: started.scaStatus, failure_code: 'SCA_REDIRECT_UNSUPPORTED', started_at: new Date().toISOString() },
    })
    return { ok: false, code: 'BANK_CONSENT_REDIRECT_UNSUPPORTED' }
  }
  // The other way round, a bank that signs in our screen anyway answers a
  // redirect start with a decoupled challenge: the attempt goes on with the
  // bank's method, and the browser shows the QR or the same-device button.
  const effective: ConsentMethod = method === 'redirect' && started.method !== 'redirect' ? started.method : method
  const attempt = attemptView(effective, started.providerAuthorisationId, { ...started, state: started.state })
  await writeAttempt(ctx, row, {
    authorization_id: started.providerAuthorisationId,
    consent_attempt: {
      ...(row.consent_attempt ?? {}),
      ...coSigning,
      method: effective,
      state: attempt.state,
      sca_status: started.scaStatus,
      failure_code: attempt.failure_code,
      started_at: new Date().toISOString(),
      ...(ret ? { return_to: ret.surface } : {}),
    },
  })
  return { ok: true, data: { connection_id: row.id, attempt } }
}

export async function startBankFeedConsent(ctx: OperationContext, input: StartInput): Promise<OperationOutcome<StartView>> {
  const door = await openBankFeedDoor(ctx)
  if (!door.ok) return { ok: false, code: 'OPEN_BANKING_NOT_AVAILABLE', details: { reason: door.reason } }
  const connect = door.connect
  const now = input.now ?? Date.now()

  // The connection this one replaces. An Open Payments row is a RENEWAL: its
  // bank, sparbank, name and agreement context fix the new consent, and
  // finalize_open_payments_consent supersedes it as it does any older row of
  // the bank once the new consent is valid (the new recurring consent makes
  // the old one expire at the bank when authorised). An Enable Banking row is
  // a SWITCH, handed over at account selection.
  let renewed: RenewedConnection | null = null
  if (input.replaceConnectionId) {
    const { data: replaced, error } = await ctx.supabase
      .from('bank_connections')
      .select('id, status, aggregator, bic, affiliated_aspsp_id, bank_name, psu_type, session_id')
      .eq('id', input.replaceConnectionId)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (error) throw error
    const old = replaced as ({ status: string; aggregator?: string | null } & RenewedConnection) | null
    if (!old || old.status === 'revoked') return { ok: false, code: 'NOT_FOUND', details: { field: 'replace_connection_id' } }
    if (aggregatorOf(old) === 'open_payments') renewed = old
  }
  // A renewal stays at its bank: the row's BIC, not the browser's, and a
  // browser naming another bank is a bug surfaced, not a silent move.
  if (renewed?.bic && input.bic !== renewed.bic) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'bic', reason: 'renewal_other_bank' } }
  }
  const bic = renewed?.bic ?? input.bic

  let bank: AisBankDetails
  try {
    bank = await connect.getBankDetails(ctx.companyId, bic)
  } catch (error) {
    if (error instanceof BankFeedRefusedError && error.code === BANK_FEED_NOT_FOUND) return { ok: false, code: 'BANK_CONSENT_UNKNOWN_BANK' }
    return providerFailure(error, ctx.log)
  }
  // The sparbank behind a shared BIC: the connection is named after it, not
  // after Swedbank, so the rows and the title say which bank it is. A renewal
  // keeps the row's sparbank.
  const affiliatedAspspId = renewed ? renewed.affiliated_aspsp_id ?? input.affiliatedAspspId ?? null : input.affiliatedAspspId ?? null
  const affiliate = affiliatedAspspId ? (bank.affiliates.find((a) => a.id === affiliatedAspspId) ?? null) : null
  if (affiliatedAspspId && bank.affiliates.length > 0 && !affiliate) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'affiliated_aspsp_id', reason: 'unknown_affiliate' } }
  }
  // A bank that only signs on its own page is started that way when the
  // caller said where to come back to; a bank that also signs in our screen
  // keeps the method the person chose. Decided before anything is created,
  // so a redirect without a return leaves no consent behind.
  const ret = signingReturn(input.returnTo, input.returnOrigin, input.returnToken)
  const method: ConsentMethod = bank.decoupled === false && bank.redirect === true && ret ? 'redirect' : input.method
  if (method === 'redirect' && !ret) return RETURN_REQUIRED

  // The bank agreement of a legal form that trades under the owner's
  // personnummer is the owner's private one; every other form has a
  // corporate agreement. The caller may say otherwise; a renewal keeps the
  // agreement the consent was granted under.
  const { data: company } = await ctx.supabase.from('companies').select('entity_type').eq('id', ctx.companyId).maybeSingle()
  const entityType = (company as { entity_type?: string | null } | null)?.entity_type
  const accountContext = input.accountContext ?? (isEntityType(entityType) && usesPersonnummerAsOrgNumber(entityType) ? 'private' : 'corporate')
  const psuType: PsuType = renewed?.psu_type === 'personal' || renewed?.psu_type === 'business' ? renewed.psu_type : psuTypeOf(accountContext)

  const party = await buildBankFeedParty(ctx.supabase, {
    companyId: ctx.companyId,
    bic: bank.bic,
    affiliatedAspspId,
    psuType,
    signer: input.signer,
    userId: ctx.userId,
    requireSigner: true,
  })
  if (!party.ok) return party.outcome

  // A new attempt replaces an abandoned one for the same bank, and the
  // company's stale attempts go with it. A partially authorised attempt waits
  // for its second signatory and is never swept. Never-finished rows hold no data.
  const { data: pendingRows } = await ctx.supabase
    .from('bank_connections')
    .select('id, bic, created_at, session_id, consent_attempt')
    .eq('company_id', ctx.companyId)
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .eq('status', 'pending')
  const swept = ((pendingRows ?? []) as Array<{ id: string; bic: string | null; created_at: string; session_id: string | null; consent_attempt: ConsentAttempt | null }>)
    .filter((r) => r.consent_attempt?.state !== 'partially_authorised')
    .filter((r) => r.bic === bank.bic || new Date(r.consent_attempt?.started_at ?? r.created_at).getTime() < now - STALE_ATTEMPT_MS)
  if (swept.length > 0) {
    // End each abandoned attempt's consent before its row goes: a company
    // holds one bank connection at Connect, and a consent left behind would
    // hold that place and refuse this new attempt. Best effort: one already
    // ended (or never signed) answers so, which changes nothing here.
    await Promise.all(
      swept
        .filter((r) => r.session_id)
        .map((r) => connect.revokeConsent(ctx.companyId, { party: party.party, consentId: r.session_id! }).catch(() => {})),
    )
    await ctx.supabase.from('bank_connections').delete().in('id', swept.map((r) => r.id)).eq('company_id', ctx.companyId).eq('aggregator', OPEN_PAYMENTS_AGGREGATOR).eq('status', 'pending')
  }

  const listingOnly = bank.bic === SVEA_BIC
  const createConsent = () => connect.createConsent(ctx.companyId, { party: party.party, validUntil: validUntilRequested(now) })
  let created: Awaited<ReturnType<typeof createConsent>> | null = null
  try {
    created = await createConsent()
  } catch (error) {
    // Connect holds one bank connection per company. A place held by a
    // consent this company no longer needs (the one a renewal replaces, or a
    // removed connection's that the bank did not end at the time) is freed,
    // and the consent asked for once more.
    let failure: unknown = error
    if (isQuotaRefusal(error) && (await releaseHeldConsents(ctx, connect, renewed))) {
      created = await createConsent().catch((retryError: unknown) => {
        failure = retryError
        return null
      })
    }
    if (!created) {
      ctx.log.warn('bank consent did not start', { code: failure instanceof BankFeedError ? failure.code : undefined })
      return providerFailure(failure, ctx.log)
    }
  }

  const attempt: ConsentAttempt = {
    method,
    state: 'pending',
    started_at: new Date(now).toISOString(),
    listing_only: listingOnly,
    // The Enable Banking row a switch hands over at selection; a renewed Open
    // Payments row is superseded by finalize instead, never handed over.
    replace_connection_id: renewed ? null : input.replaceConnectionId ?? null,
    extended_history_days: bank.extendedTransactionHistoryMaxDays ?? bank.transactionHistoryMaxDays ?? null,
    return_to: ret?.surface ?? null,
  }
  const { data: inserted, error: insertError } = await ctx.supabase
    .from('bank_connections')
    .insert({
      company_id: ctx.companyId,
      user_id: ctx.userId,
      aggregator: OPEN_PAYMENTS_AGGREGATOR,
      provider: OPEN_PAYMENTS_PROVIDER_SLUG,
      // The same name as the renewed row: finalize supersedes by bank_name.
      bank_name: renewed?.bank_name ?? affiliate?.name ?? bank.name,
      bic: bank.bic,
      affiliated_aspsp_id: affiliatedAspspId,
      session_id: created.consentId,
      status: 'pending',
      psu_type: psuType,
      consent_expires: consentExpiresAt(created.validUntil),
      consent_attempt: attempt,
    })
    .select(ROW_COLUMNS)
    .single()
  if (insertError || !inserted) {
    // Nothing points at the consent: end it rather than leave it signable.
    await connect.revokeConsent(ctx.companyId, { party: party.party, consentId: created.consentId }).catch(() => {})
    return { ok: false, code: 'INTERNAL_ERROR', error: insertError ?? new Error('Bank connection attempt not stored') }
  }
  // The bank accepted the consent with this PSU-ID: every later call to it sends the same one.
  await rememberConsentPsu(ctx, (inserted as Row).id, party)
  return startSigning(ctx, connect, inserted as Row, party.party, method, ret)
}

export async function restartBankFeedConsent(
  ctx: OperationContext,
  input: {
    connectionId: string
    method?: ConsentMethod | null
    signer?: BankFeedSignerInput
    /** Redirect: the entry point to come back to (the row's own when absent) and the app origin the request came to. */
    returnTo?: BankConnectReturnTarget | null
    returnOrigin?: string | null
    /** The signatory page's link token (the koppla target only). */
    returnToken?: string | null
    now?: number
  },
): Promise<OperationOutcome<StartView>> {
  const connect = getBankFeedConnect()
  if (!connect) return { ok: false, code: 'OPEN_BANKING_NOT_AVAILABLE', details: { reason: 'no_connector' } }
  const row = await loadRow(ctx, input.connectionId)
  if (!row) return { ok: false, code: 'NOT_FOUND' }
  if (row.status !== 'pending' || !row.session_id || !row.bic) return { ok: false, code: 'BANK_CONSENT_CHANGED' }
  const ret = signingReturn(input.returnTo ?? row.consent_attempt?.return_to, input.returnOrigin, input.returnToken)
  // The bank imposed its own page on the last attempt (SCA_REDIRECT_UNSUPPORTED):
  // "starta om och välj bankens sida" is this restart, so it goes there when
  // the browser said where to come back to, whatever method it asked for.
  const imposed = row.consent_attempt?.state === 'failed' && row.consent_attempt.failure_code === 'SCA_REDIRECT_UNSUPPORTED'
  const method: ConsentMethod = imposed && ret ? 'redirect' : input.method ?? row.consent_attempt?.method ?? 'qr'
  // A partly signed consent waits for a co-signer: their own BankID, their
  // number. Any other restart is the same consent again, with the PSU-ID it
  // was created with.
  const coSigning = isCoSigning(row.consent_attempt)
  const party = await partyFor(ctx, row, input.signer ?? UNATTENDED_SIGNER, false, { coSigner: coSigning })
  if (!party.ok) return party.outcome
  // A consent whose signing window closed is created anew; the attempt record
  // (listing-only, the row a switch replaces, the return) carries over.
  const started = await startSigning(ctx, connect, row, party.party, method, ret, { coSigning })
  if (!started.ok && started.code === 'BANK_CONSENT_OVER') {
    const now = input.now ?? Date.now()
    let created
    try {
      created = await connect.createConsent(ctx.companyId, {
        party: party.party,
        validUntil: validUntilRequested(now),
        ...(row.consent_attempt?.selection?.accounts
          ? { accounts: chosenIbans(row) }
          : {}),
      })
    } catch (error) {
      return providerFailure(error, ctx.log)
    }
    // A new consent, created with this party's PSU-ID and signed from the
    // start: it replaces the kept number, and nobody co-signs it yet.
    const attempt: ConsentAttempt = { ...(row.consent_attempt ?? {}), co_signing: false }
    await writeAttempt(ctx, row, { session_id: created.consentId, consent_expires: consentExpiresAt(created.validUntil), authorization_id: null, consent_attempt: attempt })
    await rememberConsentPsu(ctx, row.id, party)
    return startSigning(ctx, connect, { ...row, session_id: created.consentId, consent_attempt: attempt }, party.party, method, ret)
  }
  return started
}

function chosenIbans(row: Row): Array<{ iban: string }> {
  const chosen = new Set((row.consent_attempt?.selection?.accounts ?? []).filter((a) => a.enabled).map((a) => a.uid))
  return (row.accounts_data ?? [])
    .filter((a) => chosen.has(a.uid))
    .map((a) => normalizeIban(a.iban))
    .filter((iban): iban is string => Boolean(iban))
    .map((iban) => ({ iban }))
}

/** The accounts of a connection awaiting selection, each with the ledger it would get and the one it already has. */
async function accountChoices(ctx: OperationContext, accounts: readonly BankFeedAccount[]): Promise<ConsentAccountView[]> {
  const used = new Set<string>()
  const views = new Map<string, ConsentAccountView>()
  // Selected accounts are placed first so they get the natural BAS numbers.
  const ordered = [...accounts].sort((a, b) => Number(b.enabled !== false) - Number(a.enabled !== false))
  // The seeded row goes to the account its onboarding payment details name (crm#1498).
  const consent = ordered.filter((a) => a.enabled !== false && !a.ledger_account)
  for (const account of ordered) {
    let suggested: string | null = account.ledger_account ?? null
    let existing: string | null = null
    if (!suggested) {
      const resolved = await resolvePsd2LedgerAccount(ctx.supabase, ctx.companyId, ctx.userId, {
        iban: account.iban ?? null, bban: account.bban ?? null, currency: account.currency, accountName: account.name ?? null,
        consent, exclude: used, prepareOnly: true,
      }).catch(() => null)
      suggested = resolved?.ledgerAccount ?? null
      if (resolved?.source === 'iban') existing = resolved.ledgerAccount
    }
    if (suggested) used.add(suggested)
    views.set(account.uid, {
      uid: account.uid,
      name: account.name ?? null,
      iban: account.iban ?? null,
      bban: account.bban ?? null,
      currency: account.currency,
      usage: account.usage ?? null,
      preselected: account.enabled !== false,
      enabled: account.enabled !== false,
      suggested_ledger_account: suggested,
      matches_existing: existing,
    })
  }
  return accounts.map((a) => views.get(a.uid)!)
}

export async function pollBankFeedConsent(
  ctx: OperationContext,
  input: { connectionId: string; signer?: BankFeedSignerInput; keepAlive?: (work: Promise<unknown>) => void },
): Promise<OperationOutcome<PollView>> {
  const connect = getBankFeedConnect()
  if (!connect) return { ok: false, code: 'OPEN_BANKING_NOT_AVAILABLE', details: { reason: 'no_connector' } }
  const row = await loadRow(ctx, input.connectionId)
  if (!row) return { ok: false, code: 'NOT_FOUND' }
  const method: ConsentMethod = row.consent_attempt?.method ?? 'qr'
  const base = (state: PollView['state'], extra: Partial<PollView> = {}): OperationOutcome<PollView> => ({
    ok: true,
    data: {
      connection_id: row.id, state, method, challenge: null, sca_status: null, step: null, failure_code: null, failure_text: null,
      status: row.status, ...extra,
    },
  })

  // A second poll that also saw the consent valid finds the work done.
  if (row.status === 'pending_selection') {
    return base('valid', { accounts: await accountChoices(ctx, row.accounts_data ?? []), consent_expires: row.consent_expires, needs_second_consent: row.consent_attempt?.selection?.listing_only === true })
  }
  if (row.status === 'active') return base('valid', { consent_expires: row.consent_expires })
  if (row.status !== 'pending' || !row.session_id || !row.bic) return { ok: false, code: 'BANK_CONSENT_CHANGED' }
  if (!row.authorization_id) {
    const failure = row.consent_attempt?.failure_code ?? 'SIGNING_UNSUCCESSFUL'
    return base('failed', { failure_code: failure, failure_text: consentFailureText(failure).sv })
  }

  // The consent's own calls carry the PSU-ID it was created with; a
  // co-signer's authorisation is polled with the co-signer's number.
  const party = await partyFor(ctx, row, input.signer ?? UNATTENDED_SIGNER, false)
  if (!party.ok) return party.outcome
  let signingParty = party.party
  if (isCoSigning(row.consent_attempt)) {
    const coSigner = await partyFor(ctx, row, input.signer ?? UNATTENDED_SIGNER, false, { coSigner: true })
    if (!coSigner.ok) return coSigner.outcome
    signingParty = coSigner.party
  }
  let progress: AisConsentSigningProgress
  try {
    progress = await connect.pollConsentSigning(ctx.companyId, { party: signingParty, consentId: row.session_id, providerAuthorisationId: row.authorization_id, method })
  } catch (error) {
    return providerFailure(error, ctx.log)
  }

  const state = progress.state
  if (state === 'pending' || state === 'partially_authorised') {
    const previous = row.consent_attempt?.state
    if (previous !== state || (row.consent_attempt?.sca_status ?? null) !== (progress.scaStatus ?? null)) {
      await writeAttempt(ctx, row, { consent_attempt: { ...(row.consent_attempt ?? {}), state, sca_status: progress.scaStatus ?? null } })
    }
    const view = attemptView(method, row.authorization_id, { ...progress, state })
    return base(state, { challenge: view.challenge, sca_status: view.sca_status, step: view.step })
  }
  if (progress.state === 'failed') {
    // The attempt is over but the row stays: restart gives it a new authorisation.
    const failure = progress.failureCode ?? 'SIGNING_UNSUCCESSFUL'
    await writeAttempt(ctx, row, { consent_attempt: { ...(row.consent_attempt ?? {}), state: 'failed', sca_status: progress.scaStatus ?? null, failure_code: failure } })
    return base('failed', { sca_status: progress.scaStatus ?? null, failure_code: failure, failure_text: consentFailureText(failure).sv })
  }

  // Valid: read the accounts and make the row await selection, once.
  const listingOnly = row.consent_attempt?.listing_only === true
  let accounts: AisAccount[]
  try {
    accounts = await connect.accounts(ctx.companyId, { party: party.party, consentId: row.session_id, withBalance: !listingOnly })
  } catch (error) {
    return providerFailure(error, ctx.log)
  }
  const observedAt = new Date().toISOString()
  const expires = progress.validUntil ? consentExpiresAt(progress.validUntil) : row.consent_expires
  const { data: finalized, error } = await createServiceClient().rpc('finalize_open_payments_consent', {
    p_company_id: ctx.companyId,
    p_user_id: ctx.userId,
    p_connection_id: row.id,
    p_consent_id: row.session_id,
    p_consent_expires: expires,
    p_accounts: toStoredAccounts(accounts, observedAt),
  })
  if (error) return databaseFailure(error)
  const receipt = finalized as { already_finalized?: boolean; accounts?: BankFeedAccount[]; superseded?: Array<{ id: string; session_id: string | null }> } | null
  if (receipt && receipt.already_finalized !== true) {
    await emitQuietly(ctx, {
      type: 'bank_connection.consent_granted',
      payload: { connectionId: row.id, bankName: row.bank_name, accountCount: receipt.accounts?.length ?? 0, consentExpiresAt: expires, userId: ctx.userId, companyId: ctx.companyId },
    })
    for (const sibling of receipt.superseded ?? []) {
      await emitQuietly(ctx, {
        type: 'bank_connection.superseded',
        payload: { connectionId: sibling.id, supersededById: row.id, bankName: row.bank_name, userId: ctx.userId, companyId: ctx.companyId },
      })
    }
  }

  // Svea's second consent: the person chose the accounts before signing it,
  // so the selection is saved now and the connection goes straight to active.
  // The first import is the sync the browser asks for next. The listing
  // consent has served its purpose only now that the second one is valid:
  // ending it is best effort.
  const chosen = row.consent_attempt?.selection?.accounts
  if (chosen && !listingOnly) {
    const fresh = await loadRow(ctx, row.id)
    if (fresh) {
      const saved = await saveSelection(ctx, fresh, chosen.map((a) => ({ uid: a.uid, enabled: a.enabled, ledgerAccount: a.ledger_account })), { skipInitialSync: true })
      if (!saved.ok) return saved
    }
    const listingConsentId = row.consent_attempt?.listing_consent_id
    if (listingConsentId && listingConsentId !== row.session_id) {
      await connect.revokeConsent(ctx.companyId, { party: party.party, consentId: listingConsentId }).catch(() => {})
    }
    return base('valid', { consent_expires: expires, status: 'active' })
  }
  return base('valid', {
    accounts: await accountChoices(ctx, (receipt?.accounts ?? []) as BankFeedAccount[]),
    consent_expires: expires,
    needs_second_consent: listingOnly,
    status: 'pending_selection',
  })
}

type CoreEventInput = Parameters<typeof eventBus.emit>[0]

async function emitQuietly(ctx: OperationContext, event: CoreEventInput): Promise<void> {
  try {
    await eventBus.emit(event)
  } catch (emitError) {
    ctx.log.error('bank feed event not emitted', { type: event.type, message: emitError instanceof Error ? emitError.message : String(emitError) })
  }
}

// ---------------------------------------------------------------------------
// select, sync, disconnect
// ---------------------------------------------------------------------------

export interface SelectionInput {
  uid: string
  enabled: boolean
  ledgerAccount?: string | null
}

async function saveSelection(
  ctx: OperationContext,
  row: Row,
  selection: SelectionInput[],
  options: { skipInitialSync?: boolean; signer?: BankFeedSignerInput; keepAlive?: (work: Promise<unknown>) => void; now?: number } = {},
): Promise<OperationOutcome<SelectView>> {
  let snapshot
  try {
    snapshot = await readBankConfiguration(ctx.supabase, ctx.companyId, row.id)
  } catch (error) {
    return databaseFailure(error)
  }
  const connection = snapshot.connection as typeof snapshot.connection & { aggregator?: string | null }
  if (aggregatorOf(connection) !== 'open_payments') return { ok: false, code: 'NOT_FOUND' }
  if (connection.status !== 'pending_selection' && connection.status !== 'active') return { ok: false, code: 'BANK_CONFIGURATION_CHANGED' }

  const existing = (Array.isArray(connection.accounts_data) ? connection.accounts_data : []) as BankFeedAccount[]
  const byUid = new Map(selection.map((a) => [a.uid, a]))
  if (selection.some((a) => !existing.some((e) => e.uid === a.uid))) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'accounts', reason: 'unknown_account' } }
  }
  if (selection.some((a) => a.ledgerAccount && !LEDGER.test(a.ledgerAccount))) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'ledger_account', reason: 'not_a_bank_account' } }
  }
  const enabled = existing.filter((a) => byUid.get(a.uid)?.enabled === true)
  if (enabled.length === 0 || enabled.length > MAX_ENABLED_ACCOUNTS) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'accounts', reason: enabled.length === 0 ? 'none_selected' : 'too_many' } }
  }
  const explicit = enabled.map((a) => byUid.get(a.uid)?.ledgerAccount).filter((l): l is string => Boolean(l))
  if (new Set(explicit).size !== explicit.length) return { ok: false, code: 'BANK_SELECTION_LEDGER_CONFLICT' }

  // The company's cash rows: an account already synced before (by another
  // feed or connection) keeps its row and history when its IBAN matches.
  const { data: cashRows, error: cashError } = await ctx.supabase
    .from('cash_accounts')
    .select('id, iban, currency, ledger_account')
    .eq('company_id', ctx.companyId)
  if (cashError) return databaseFailure(cashError)
  const rows = (cashRows ?? []) as Array<{ id: string; iban: string | null; currency: string; ledger_account: string }>

  // Selected accounts claim their BAS numbers first. An unselected account
  // keeps the number it already had only while no selected account wants it
  // (it yields, as in every bank feed's picker), and never gets a new one.
  const used = new Set(explicit)
  const selectionByUid = new Map<string, BankAccountSelection>()
  // The seeded row goes to the account its onboarding payment details name (crm#1498).
  const consent = enabled.filter((a) => !byUid.get(a.uid)?.ledgerAccount && !a.ledger_account)
  for (const account of enabled) {
    let ledger = byUid.get(account.uid)?.ledgerAccount ?? account.ledger_account ?? null
    let reuse: string | null = null
    if (!ledger || (used.has(ledger) && !explicit.includes(ledger))) {
      const resolved = await resolvePsd2LedgerAccount(ctx.supabase, ctx.companyId, ctx.userId, {
        iban: account.iban ?? null, bban: account.bban ?? null, currency: account.currency, accountName: account.name ?? null,
        consent, exclude: used, prepareOnly: true,
      })
      if (!resolved) return { ok: false, code: 'BANK_SELECTION_LEDGER_CONFLICT' }
      ledger = resolved.ledgerAccount
      reuse = resolved.reuseCashAccountId
    }
    used.add(ledger)
    const iban = normalizeIban(account.iban)
    if (!reuse && iban) {
      reuse = rows.find((r) => normalizeIban(r.iban) === iban && r.currency === account.currency && r.ledger_account === ledger)?.id ?? null
    }
    selectionByUid.set(account.uid, { uid: account.uid, enabled: true, currency: account.currency, ledger_account: ledger, reuse_cash_account_id: reuse })
  }
  const selections: BankAccountSelection[] = existing.map((account) => {
    const selected = selectionByUid.get(account.uid)
    if (selected) return selected
    const kept = account.ledger_account && !used.has(account.ledger_account) ? account.ledger_account : null
    return { uid: account.uid, enabled: false, currency: account.currency, ...(kept ? { ledger_account: kept } : {}), reuse_cash_account_id: null }
  })

  let saved
  try {
    saved = await saveBankAccountSelection(ctx.supabase, ctx.companyId, ctx.userId, connection.id, snapshot.token, selections)
  } catch (error) {
    return databaseFailure(error)
  }
  await emitQuietly(ctx, {
    type: 'bank_connection.account_selection_changed',
    payload: {
      connectionId: connection.id, bankName: connection.bank_name, previousStatus: connection.status, newStatus: saved.status,
      enabledCount: enabled.length, totalCount: existing.length, userId: ctx.userId, companyId: ctx.companyId,
    },
  })

  // The Enable Banking rows this connection takes over (./handover.ts): the
  // one a switch named, and any whose every account this connection now
  // reads, whichever door the connection came through. Each hands over its
  // history now that the selection has adopted its cash rows, and is revoked.
  // Its consent at Enable Banking lapses on its own; the Enable Banking paths
  // never touch a revoked row. Every save asks, so a handover that failed is
  // tried again by the next one.
  const replaced = row.consent_attempt?.selection?.replace_connection_id ?? row.consent_attempt?.replace_connection_id ?? null
  const { data: liveRows, error: liveError } = await ctx.supabase
    .from('bank_connections')
    .select('id, aggregator, accounts_data')
    .eq('company_id', ctx.companyId)
    .in('status', [...LIVE_CONNECTION_STATUSES])
    .is('superseded_by', null)
    .neq('id', connection.id)
  if (liveError) ctx.log.warn('enable banking rows to take over not read', { connectionId: connection.id, message: liveError.message })
  const takenOver = liveError
    ? (replaced ? [replaced] : [])
    : enableBankingRowsTakenOver({ reads: enabled, replaced, live: Array.isArray(liveRows) ? (liveRows as HandoverCandidate[]) : [] })
  for (const old of takenOver) {
    const { data: handover, error: supersedeError } = await ctx.supabase.rpc('supersede_enable_banking_connection', {
      p_company_id: ctx.companyId, p_user_id: ctx.userId, p_new: connection.id, p_old: old,
    })
    if (supersedeError) {
      // The selection stands; the switch is reported, not undone.
      ctx.log.warn('enable banking connection not superseded', { connectionId: connection.id, replaced: old, message: supersedeError.message })
    } else {
      const moved = (handover as { superseded?: Array<{ id: string }> } | null)?.superseded ?? []
      for (const sibling of moved) {
        await emitQuietly(ctx, {
          type: 'bank_connection.superseded',
          payload: { connectionId: sibling.id, supersededById: connection.id, bankName: connection.bank_name, userId: ctx.userId, companyId: ctx.companyId },
        })
      }
    }
  }

  const after = await loadRow(ctx, row.id)
  const view = connectionView(after ?? { ...row, status: saved.status, accounts_data: saved.accounts as BankFeedAccount[] })
  if (options.skipInitialSync || connection.status !== 'pending_selection') {
    return { ok: true, data: { connection: view, sync: null, sync_pending: false } }
  }

  // The first import starts now, with the person present, so it gets the
  // extended history window the bank serves right after the consent; past the
  // wait it keeps going (keepAlive), and the cron retries whatever did not land.
  const sync = runOpenPaymentsSync(ctx.supabase, {
    companyId: ctx.companyId, userId: ctx.userId, connectionId: connection.id, log: ctx.log,
    trigger: 'initial', signer: options.signer, now: options.now,
  })
  sync.catch(() => {})
  const waitMs = options.keepAlive ? INITIAL_SYNC_ANSWER_MS : INITIAL_SYNC_WAIT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    sync,
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs) }),
  ]).catch(() => null)
  if (timer) clearTimeout(timer)
  if (!result) options.keepAlive?.(sync)
  const synced = await loadRow(ctx, row.id)
  return {
    ok: true,
    data: {
      connection: synced ? connectionView(synced) : view,
      sync: result && result.ok ? { imported: result.imported, duplicates: result.duplicates, from: result.from_date, to: result.to_date } : null,
      sync_pending: !result,
    },
  }
}

export async function selectBankFeedAccounts(
  ctx: OperationContext,
  input: {
    connectionId: string
    accounts: SelectionInput[]
    method?: ConsentMethod | null
    signer?: BankFeedSignerInput
    /** Svea's second consent may sign on the bank's page: the entry point to come back to and the app origin the request came to, as for start. */
    returnTo?: BankConnectReturnTarget | null
    returnOrigin?: string | null
    /** The signatory page's link token (the koppla target only). */
    returnToken?: string | null
    keepAlive?: (work: Promise<unknown>) => void
    now?: number
  },
): Promise<OperationOutcome<SelectView>> {
  const connect = getBankFeedConnect()
  if (!connect) return { ok: false, code: 'OPEN_BANKING_NOT_AVAILABLE', details: { reason: 'no_connector' } }
  const row = await loadRow(ctx, input.connectionId)
  if (!row) return { ok: false, code: 'NOT_FOUND' }
  if (row.status === 'pending') return { ok: false, code: 'BANK_CONSENT_NOT_READY' }
  if (row.status !== 'pending_selection' && row.status !== 'active') return { ok: false, code: 'BANK_CONFIGURATION_CHANGED' }

  // Svea: the first consent only listed the accounts. A second consent naming
  // the chosen ones is created and signed; the selection waits on the row and
  // is saved when that consent is valid (pollBankFeedConsent), which is also
  // when the listing consent is ended.
  if (row.status === 'pending_selection' && row.consent_attempt?.selection?.listing_only === true) {
    const chosen = input.accounts.filter((a) => a.enabled)
    if (chosen.length === 0) return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'accounts', reason: 'none_selected' } }
    const existing = row.accounts_data ?? []
    if (chosen.some((a) => !existing.some((e) => e.uid === a.uid))) {
      return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'accounts', reason: 'unknown_account' } }
    }
    const ibans = chosen.map((a) => normalizeIban(existing.find((e) => e.uid === a.uid)?.iban)).filter((iban): iban is string => Boolean(iban))
    if (ibans.length !== chosen.length) return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'accounts', reason: 'iban_missing' } }
    // The second signing is started the way the first was: on the bank's
    // page when that is the only way it signs and the browser said where
    // to come back to, else with the person's method. The bank's details
    // come from the adapter's cache.
    const ret = signingReturn(input.returnTo ?? row.consent_attempt?.selection?.return_to ?? row.consent_attempt?.return_to, input.returnOrigin, input.returnToken)
    const requested = input.method ?? row.consent_attempt?.selection?.method ?? 'qr'
    let redirectOnly = false
    if (row.bic) {
      try {
        const bank = await connect.getBankDetails(ctx.companyId, row.bic)
        redirectOnly = bank.decoupled === false && bank.redirect === true
      } catch {
        // The person's method stands.
      }
    }
    // Without a return there is no way back from the bank's page: refused
    // before a consent exists.
    if ((redirectOnly || requested === 'redirect') && !ret) return RETURN_REQUIRED
    const method: ConsentMethod = redirectOnly ? 'redirect' : requested
    const party = await partyFor(ctx, row, input.signer ?? UNATTENDED_SIGNER, true)
    if (!party.ok) return party.outcome
    const now = input.now ?? Date.now()
    // A company holds one bank connection (Connect counts consents, and
    // every active consent is billed): the listing consent is ended before
    // the second one is created, so Svea never holds two at once. The
    // accounts it listed stay on the row, so a second consent that fails is
    // created again from them without listing anew. An end that fails (one
    // already ended answers so) does not stop the second consent.
    if (row.session_id) {
      try {
        await connect.revokeConsent(ctx.companyId, { party: party.party, consentId: row.session_id })
      } catch (error) {
        ctx.log.warn('svea listing consent not ended before the second consent', { connectionId: row.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    let created
    try {
      created = await connect.createConsent(ctx.companyId, { party: party.party, validUntil: validUntilRequested(now), accounts: ibans.map((iban) => ({ iban })) })
    } catch (error) {
      return providerFailure(error, ctx.log)
    }
    await rememberConsentPsu(ctx, row.id, party)
    const attempt: ConsentAttempt = {
      method,
      state: 'pending',
      started_at: new Date(now).toISOString(),
      listing_only: false,
      // finalize_open_payments_consent keeps only these top-level facts for
      // the selection step, as from the first consent: nested under
      // `selection` alone, the switch's row and the history window were lost.
      replace_connection_id: row.consent_attempt?.selection?.replace_connection_id ?? null,
      extended_history_days: row.consent_attempt?.selection?.extended_history_days ?? null,
      listing_consent_id: row.session_id,
      return_to: ret?.surface ?? null,
      selection: {
        ...(row.consent_attempt?.selection ?? {}),
        listing_only: false,
        method,
        accounts: input.accounts.map((a) => ({ uid: a.uid, enabled: a.enabled, ledger_account: a.ledgerAccount ?? null })),
      },
    }
    await writeAttempt(ctx, row, {
      session_id: created.consentId,
      consent_expires: consentExpiresAt(created.validUntil),
      status: 'pending',
      authorization_id: null,
      accounts_data: existing.map((a) => ({ ...a, enabled: chosen.some((c) => c.uid === a.uid) })),
      consent_attempt: attempt,
    })
    const started = await startSigning(ctx, connect, { ...row, session_id: created.consentId, status: 'pending', consent_attempt: attempt }, party.party, method, ret)
    if (!started.ok) return started
    return {
      ok: true,
      data: {
        connection: connectionView({ ...row, status: 'pending', session_id: created.consentId }),
        sync: null,
        sync_pending: false,
        ...(started.dryRun ? {} : { attempt: started.data.attempt }),
      },
    }
  }

  return saveSelection(ctx, row, input.accounts, { signer: input.signer, keepAlive: input.keepAlive, now: input.now })
}

/** "Synka nu": one read of the connection with the person present. The first read after selection takes the extended window. */
export async function syncBankFeedConnection(
  ctx: OperationContext,
  input: { connectionId: string; signer: BankFeedSignerInput; now?: number },
): Promise<OperationOutcome<Extract<TriggerSyncResult, { ok: true }>>> {
  if (!getBankFeedConnect()) return { ok: false, code: 'OPEN_BANKING_NOT_AVAILABLE', details: { reason: 'no_connector' } }
  const result = await runOpenPaymentsSync(ctx.supabase, {
    companyId: ctx.companyId, userId: ctx.userId, connectionId: input.connectionId, log: ctx.log, trigger: 'manual', signer: input.signer, now: input.now,
  })
  if (result.ok) return { ok: true, data: result }
  const { ok: _ok, code, ...details } = result
  return { ok: false, code, details }
}

/**
 * Ends the consent of a removed connection at the bank, under the claim that
 * fences a new holder while the call is out: 'ended' now, 'already_ended'
 * earlier, 'busy' while another call holds the claim, 'failed' when the
 * bank, Connect or the claim did not answer (the consent may still be live).
 */
async function endRemovedConsent(
  ctx: OperationContext,
  connect: BankFeedConnect,
  row: Pick<Row, 'id' | 'bic' | 'affiliated_aspsp_id' | 'psu_type'>,
  consentId: string,
): Promise<'ended' | 'already_ended' | 'busy' | 'failed'> {
  const service = createServiceClient()
  const identity = { p_provider: AGGREGATOR_SESSION_NAMESPACE.open_payments, p_session_id: consentId }
  try {
    const { data: claim, error: claimError } = await service.rpc('claim_bank_session_revocation', identity)
    if (claimError) throw claimError
    const token = claim as { claimed?: boolean; token?: string; reason?: string } | null
    if (token?.claimed !== true || typeof token.token !== 'string') return token?.reason === 'already-revoked' ? 'already_ended' : 'busy'
    let succeeded = false
    const party = await partyFor(ctx, row, UNATTENDED_SIGNER, false)
    if (party.ok) {
      succeeded = await connect.revokeConsent(ctx.companyId, { party: party.party, consentId }).then(() => true, () => false)
    }
    await service.rpc('finish_bank_session_revocation', { ...identity, p_claim_token: token.token, p_succeeded: succeeded })
    if (!succeeded) ctx.log.warn('bank consent not ended at the bank', { connectionId: row.id })
    return succeeded ? 'ended' : 'failed'
  } catch (error) {
    ctx.log.warn('bank consent not ended at the bank', { connectionId: row.id, message: error instanceof Error ? error.message : String(error) })
    return 'failed'
  }
}

/** The removed connection's consent, kept on the row while the bank has not ended it; null clears it once it has. */
async function markUnendedConsent(ctx: OperationContext, row: Pick<Row, 'id' | 'consent_attempt'>, consentId: string | null): Promise<void> {
  const { unended_consent_id: _previous, ...attempt } = row.consent_attempt ?? {}
  const { error } = await ctx.supabase
    .from('bank_connections')
    .update({ consent_attempt: consentId ? { ...attempt, unended_consent_id: consentId } : attempt })
    .eq('id', row.id)
    .eq('company_id', ctx.companyId)
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .eq('status', 'revoked')
  if (error) ctx.log.warn('unended bank consent not recorded', { connectionId: row.id, message: error.message })
}

/**
 * Frees the company's one place at Connect (one bank connection per company:
 * an active consent holds it until ended, an unsigned one for 15 minutes)
 * from consents the company no longer needs: the consent a renewal replaces,
 * and the consents of removed connections the bank did not end at the time.
 * Called when Connect refuses a new consent over that limit. True when a
 * consent was ended now, so asking again can succeed.
 */
async function releaseHeldConsents(ctx: OperationContext, connect: BankFeedConnect, renewed: RenewedConnection | null): Promise<boolean> {
  let freed = false
  // The renewal's own consent: the person asked for a new one in its place,
  // and the new one supersedes the row once it is valid.
  if (renewed?.session_id) {
    const party = await partyFor(ctx, renewed, UNATTENDED_SIGNER, false)
    if (party.ok) {
      freed = await connect.revokeConsent(ctx.companyId, { party: party.party, consentId: renewed.session_id }).then(() => true, () => false)
    }
    if (!freed) ctx.log.warn('renewed bank consent not ended before the new one', { connectionId: renewed.id })
  }
  const { data, error } = await ctx.supabase
    .from('bank_connections')
    .select('id, bic, affiliated_aspsp_id, psu_type, consent_attempt')
    .eq('company_id', ctx.companyId)
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .eq('status', 'revoked')
    .not('consent_attempt->>unended_consent_id', 'is', null)
  if (error) {
    ctx.log.warn('removed connections with a live consent not read', { message: error.message })
    return freed
  }
  for (const removed of (data ?? []) as Array<Pick<Row, 'id' | 'bic' | 'affiliated_aspsp_id' | 'psu_type' | 'consent_attempt'>>) {
    const consentId = removed.consent_attempt?.unended_consent_id
    if (!consentId) continue
    const outcome = await endRemovedConsent(ctx, connect, removed, consentId)
    if (outcome === 'ended' || outcome === 'already_ended') await markUnendedConsent(ctx, removed, null)
    if (outcome === 'ended') freed = true
  }
  return freed
}

/** Remove the connection and end its consent at the bank. */
export async function disconnectBankFeedConnection(ctx: OperationContext, connectionId: string): Promise<OperationOutcome<{ connection_id: string }>> {
  const row = await loadRow(ctx, connectionId)
  if (!row) return { ok: false, code: 'NOT_FOUND' }
  let released
  try {
    const snapshot = await readBankConfiguration(ctx.supabase, ctx.companyId, connectionId)
    released = await disconnectBankConnection(ctx.supabase, ctx.companyId, ctx.userId, connectionId, snapshot.token)
  } catch (error) {
    return databaseFailure(error)
  }

  // The local disconnect stands. Ending the consent at the bank is best
  // effort; one the bank did not end stays on the row, because Connect keeps
  // counting it as the company's bank connection: the next attempt ends it.
  const connect = getBankFeedConnect()
  if (released.session_id && row.bic && connect) {
    const outcome = await endRemovedConsent(ctx, connect, row, released.session_id)
    if (outcome === 'failed') await markUnendedConsent(ctx, row, released.session_id)
  }
  await emitQuietly(ctx, {
    type: 'bank_connection.revoked',
    payload: { connectionId, bankName: released.bank_name, userId: ctx.userId, companyId: ctx.companyId },
  })
  return { ok: true, data: { connection_id: connectionId } }
}

/** The connection as the dashboard shows it, for the routes that answer with one. */
export async function getBankFeedConnection(ctx: OperationContext, connectionId: string): Promise<OperationOutcome<ConnectionView>> {
  const row = await loadRow(ctx, connectionId)
  if (!row) return { ok: false, code: 'NOT_FOUND' }
  return { ok: true, data: connectionView(row) }
}

export type { SupabaseClient }
export { accountContextOf }
