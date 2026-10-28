/**
 * The browser side of bank reading through Open Payments: the shapes the
 * session routes under /api/bank/open-payments answer with (lib/bank-feed/
 * service.ts: BankView, StartView, PollView, SelectView, ConnectionView,
 * OverviewView), and one fetch helper per route. Every call the Koppla banken
 * flow makes goes through here, so the dialog, the settings rows and the
 * onboarding step send the same bodies and read the same envelopes.
 *
 * Nothing here is logged: a QR payload or an autostart token belongs to the
 * person at the bank and is rendered, never printed.
 */

import type { BankConnectReturnTarget } from '@/lib/bank-feed/return-url'

/** One bank as GET /api/bank/open-payments/banks lists it. Svea Bank comes with nulls. */
export interface OpenPaymentsBank {
  bic: string
  name: string
  logo_url: string | null
  /** The bank signs in the BankID app (QR or same device); false means it signs only on its own page (redirect). Null: the list does not know; the details do. */
  decoupled: boolean | null
  /** The bank signs on its own page: the browser goes there and comes back. */
  redirect: boolean | null
  /** Open Payments reaches the bank for this company (lib/bank-feed/bank-coverage.ts bankReached); absent from an older server. */
  reached?: boolean
}

/** One bank's details as GET /api/bank/open-payments/banks/:bic answers (service BankDetailsView). */
export interface OpenPaymentsBankDetails {
  bic: string
  name: string
  decoupled: boolean | null
  redirect: boolean | null
  /** The sparbanker behind a shared BIC (SWEDSESS); the chosen one goes in affiliated_aspsp_id. */
  affiliates: Array<{ id: string; name: string }>
  transaction_history_max_days: number | null
  extended_transaction_history_max_days: number | null
}

export interface BankIdChallenge {
  approach: 'decoupled' | 'redirect'
  autostartToken: string | null
  qrData: string | null
  /** The QR as a finished image (data: URL) when the bank sends no data to draw it from. */
  qrImage: string | null
  redirectUrl: string | null
}

/** The bank's two consent steps: identify the person, then approve access to the accounts. */
export type ConsentStep = 'identify' | 'consent'

/** BankID in our screen (qr, same_device) or on the bank's own page (redirect). */
export type ConnectMethod = 'qr' | 'same_device' | 'redirect'

/** The entry point a redirect signing comes back to (lib/bank-feed/return-url.ts); the signatory page is its own target. */
export type ReturnSurface = BankConnectReturnTarget

export type AccountContext = 'corporate' | 'private'

export type AttemptState = 'pending' | 'failed' | 'partially_authorised'

/** The BankID attempt in flight (service AttemptView). A start can fail at once: state 'failed' with the bank's text. */
export interface ConnectionAttempt {
  authorisation_id: string | null
  method: ConnectMethod
  state: AttemptState
  challenge: BankIdChallenge | null
  sca_status: string | null
  step: ConsentStep | null
  failure_code: string | null
  /** The bank's refusal in Swedish, when it gave one. */
  failure_text: string | null
}

export interface CreateConnectionInput {
  bic: string
  affiliated_aspsp_id?: string
  account_context?: AccountContext
  method: ConnectMethod
  personal_number?: string
  /** Nordea Corporate Netbank: the signer's logon id, when typed (never stored server-side). */
  psu_authoriser_id?: string
  /** The connection this one takes over from (a switch from Enable Banking, or a renewal). */
  replace_connection_id?: string
  /** Redirect: the page to come back to after signing at the bank. */
  return_to?: ReturnSurface
}

export interface CreateConnectionResult {
  connection_id: string
  attempt: ConnectionAttempt
}

/** Restart and select may start a BankID: the method and, when nothing is on file, the typed personnummer (never stored server-side). */
export interface SignerInput {
  method?: ConnectMethod
  personal_number?: string
  /** Nordea Corporate Netbank: the signer's own logon id, when typed. */
  psu_authoriser_id?: string
  /** Redirect: the page to come back to after signing at the bank. */
  return_to?: ReturnSurface
}

export type ConnectionPollState = 'pending' | 'valid' | 'partially_authorised' | 'failed'

/** One of the bank's accounts, as the poll lists them once the consent is valid (service ConsentAccountView). */
export interface PolledAccount {
  uid: string
  name: string | null
  iban: string | null
  bban: string | null
  currency: string
  /** ORGA for a company account, PRIV for a private one; a bank may send nothing. */
  usage: 'ORGA' | 'PRIV' | string | null
  /** The company's accounts (ORGA) start selected; the signer's own (PRIV) do not. */
  preselected: boolean
  enabled: boolean
  /** The BAS number a new account would get. */
  suggested_ledger_account: string | null
  /** The ledger of the cash account this company already books the same IBAN and currency on; null when none. */
  matches_existing: string | null
}

export interface ConnectionPoll {
  connection_id: string
  state: ConnectionPollState
  method: ConnectMethod
  challenge: BankIdChallenge | null
  sca_status: string | null
  step: ConsentStep | null
  failure_code: string | null
  failure_text: string | null
  /** On valid, while the connection awaits account selection. Absent after Svea's second consent. */
  accounts?: PolledAccount[]
  consent_expires?: string | null
  /** Svea: the chosen accounts are confirmed with a second BankID. */
  needs_second_consent?: boolean
  /** The connection row's status after this poll. */
  status: string
}

export interface AccountSelection {
  uid: string
  enabled: boolean
  /** Null for an account that is switched off. */
  ledger_account: string | null
}

export interface ConnectionViewAccount {
  uid: string
  name: string | null
  iban: string | null
  currency: string
  enabled: boolean
  ledger_account: string | null
  usage: string | null
}

/** A connection as the routes describe it (service ConnectionView). */
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
  accounts: ConnectionViewAccount[]
}

/** GET /api/bank/open-payments/connections: the company's Open Payments connections and whether the person has a signer on file. */
export interface OpenPaymentsOverview {
  available: boolean
  reason: 'no_connector' | 'not_in_pilot' | 'subscription' | null
  connections: ConnectionView[]
  signer_known: boolean
}

/** The first import as select reports it when it finished inside the request. */
export interface FirstSync {
  imported: number
  duplicates: number
  from: string
  to: string
}

/** POST .../select (service SelectView). */
export interface SelectAccountsResult {
  connection: ConnectionView
  /** Null when the import runs on (sync_pending) or was not due. */
  sync: FirstSync | null
  sync_pending: boolean
  /** Svea: the second consent to sign; poll the connection again, then call sync. */
  attempt?: ConnectionAttempt | null
}

export function isSecondConsent(result: SelectAccountsResult): result is SelectAccountsResult & { attempt: ConnectionAttempt } {
  return result.attempt !== undefined && result.attempt !== null
}

/** POST .../sync: one read with the person present. */
export interface SyncResult {
  connection_id: string
  bank: string | null
  imported: number
  duplicates: number
  from_date: string
  to_date: string
  last_synced_at: string | null
}

/** The company is not switched on for Open Payments reading: hide every entry point. */
export const OPEN_BANKING_NOT_AVAILABLE = 'OPEN_BANKING_NOT_AVAILABLE'

/** A sync refused with 429 because one ran recently or the bank limits reads: calm, the feed runs on its own. */
export const SYNC_COOLDOWN_CODES: ReadonlySet<string> = new Set(['BANK_SYNC_COOLDOWN', 'BANK_RATE_LIMITED'])

export class OpenPaymentsClientError extends Error {
  constructor(
    readonly body: unknown,
    readonly status: number,
  ) {
    super(`open payments request failed (${status})`)
    this.name = 'OpenPaymentsClientError'
  }

  get code(): string | null {
    const code = (this.body as { error?: { code?: unknown } } | null)?.error?.code
    return typeof code === 'string' ? code : null
  }

  /** The 429 body's next_allowed_at (ISO), when the error carries one. */
  get nextAllowedAt(): string | null {
    const details = (this.body as { error?: { details?: { next_allowed_at?: unknown } } } | null)?.error?.details
    return typeof details?.next_allowed_at === 'string' ? details.next_allowed_at : null
  }
}

/** Whether a failed sync is the calm kind: synced recently, or the bank limits reads. */
export function isSyncCooldown(error: unknown): boolean {
  return error instanceof OpenPaymentsClientError && error.code !== null && SYNC_COOLDOWN_CODES.has(error.code)
}

/** The bank's short throttle (429 BANK_THROTTLED): busy for a moment, not the daily cap; one calm line, the feed tries again on its own. */
export const BANK_BUSY_CODE = 'BANK_THROTTLED'

export function isBankBusy(error: unknown): boolean {
  return error instanceof OpenPaymentsClientError && error.code === BANK_BUSY_CODE
}

/** The session routes, for a logged-in member of the active company. */
export const OPEN_PAYMENTS_SESSION_BASE = '/api/bank/open-payments'

/** The token routes a firmatecknare reaches without a login (app/api/koppla/[token]); same bodies, same envelopes. */
export function openPaymentsSignatoryBase(token: string): string {
  return `/api/koppla/${encodeURIComponent(token)}`
}

async function send<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) throw new OpenPaymentsClientError(body, res.status)
  return (body as { data: T }).data
}

export type OpenPaymentsAvailability = { available: true; banks: OpenPaymentsBank[] } | { available: false; banks: null }

/**
 * The calls the Koppla banken flow makes, bound to one base path: the
 * session routes for the dialog, the token routes for the signatory page.
 * Both answer the same shapes, so the flow controller takes an
 * OpenPaymentsApi and never knows which door it talks through.
 */
export interface OpenPaymentsApi {
  fetchAvailability(signal?: AbortSignal): Promise<OpenPaymentsAvailability>
  fetchBankDetails(bic: string, signal?: AbortSignal): Promise<OpenPaymentsBankDetails>
  fetchConnection(connectionId: string, signal?: AbortSignal): Promise<ConnectionView>
  createConnection(input: CreateConnectionInput): Promise<CreateConnectionResult>
  /** The poll repeats the typed personnummer (and a Nordea logon id): the bank wants the PSU named on every call about the consent. */
  pollConnection(connectionId: string, signal?: AbortSignal, signer?: Pick<SignerInput, 'personal_number' | 'psu_authoriser_id'>): Promise<ConnectionPoll>
  restartConnection(connectionId: string, signer?: SignerInput): Promise<CreateConnectionResult>
  selectAccounts(connectionId: string, accounts: AccountSelection[], signer?: SignerInput): Promise<SelectAccountsResult>
  syncConnection(connectionId: string): Promise<SyncResult>
  deleteConnection(connectionId: string): Promise<{ connection_id: string }>
}

export function createOpenPaymentsApi(base: string): OpenPaymentsApi {
  const connection = (connectionId: string) => `${base}/connections/${encodeURIComponent(connectionId)}`
  return {
    /**
     * Whether the company may read its bank through Open Payments, and the
     * banks when it may. The banks route answers 403 OPEN_BANKING_NOT_AVAILABLE
     * for a company that is not switched on; any other failure also hides the
     * entry points, since a button that leads to an error is worse than none.
     */
    async fetchAvailability(signal) {
      try {
        const { banks } = await send<{ banks: OpenPaymentsBank[] }>(`${base}/banks`, { signal })
        return { available: true, banks }
      } catch (error) {
        if (error instanceof OpenPaymentsClientError) return { available: false, banks: null }
        throw error
      }
    },
    fetchBankDetails(bic, signal) {
      return send<OpenPaymentsBankDetails>(`${base}/banks/${encodeURIComponent(bic)}`, { signal })
    },
    fetchConnection(connectionId, signal) {
      return send<ConnectionView>(connection(connectionId), { signal })
    },
    createConnection(input) {
      return send<CreateConnectionResult>(`${base}/connections`, { method: 'POST', body: JSON.stringify(input) })
    },
    pollConnection(connectionId, signal, signer = {}) {
      return send<ConnectionPoll>(`${connection(connectionId)}/poll`, {
        method: 'POST',
        body: JSON.stringify({
          ...(signer.personal_number ? { personal_number: signer.personal_number } : {}),
          ...(signer.psu_authoriser_id ? { psu_authoriser_id: signer.psu_authoriser_id } : {}),
        }),
        signal,
      })
    },
    restartConnection(connectionId, signer = {}) {
      return send<CreateConnectionResult>(`${connection(connectionId)}/restart`, { method: 'POST', body: JSON.stringify(signer) })
    },
    selectAccounts(connectionId, accounts, signer = {}) {
      return send<SelectAccountsResult>(`${connection(connectionId)}/select`, { method: 'POST', body: JSON.stringify({ accounts, ...signer }) })
    },
    syncConnection(connectionId) {
      return send<SyncResult>(`${connection(connectionId)}/sync`, { method: 'POST', body: JSON.stringify({}) })
    },
    deleteConnection(connectionId) {
      return send<{ connection_id: string }>(connection(connectionId), { method: 'DELETE' })
    },
  }
}

/** The session door, used by the settings rows, the onboarding step and the dialog. */
export const sessionOpenPaymentsApi: OpenPaymentsApi = createOpenPaymentsApi(OPEN_PAYMENTS_SESSION_BASE)

export function fetchOpenPaymentsAvailability(signal?: AbortSignal): Promise<OpenPaymentsAvailability> {
  return sessionOpenPaymentsApi.fetchAvailability(signal)
}

/** One Enable Banking connection the switch campaign still waits for (GET .../switch-progress). */
export interface BankSwitchConnection {
  connection_id: string
  bank_name: string
}

/** Where the company stands in the Enable Banking to Open Payments switch (lib/bank-feed/switch-campaign.ts). */
export interface BankSwitchCompanyState {
  state: 'done' | 'pending' | 'uncovered'
  pending: BankSwitchConnection[]
  uncovered: BankSwitchConnection[]
  open_payments: number
  deadline: string
  days_left: number
  passed: boolean
  urgent: boolean
}

export interface BankSwitchProgressView {
  campaign: { on: boolean; deadline: string | null; days_left: number | null; passed: boolean }
  /** Null when the campaign does not apply to the company. */
  company: BankSwitchCompanyState | null
  /** Cross-company counts, owners and admins only; null otherwise. */
  totals: {
    companies: { pending: number; uncovered: number; done: number }
    connections: { pending: number; uncovered: number; switched: number }
    banks: Array<{ bank: string; pending: number; uncovered: number; switched: number }>
  } | null
}

export function fetchBankSwitchProgress(signal?: AbortSignal): Promise<BankSwitchProgressView> {
  return send<BankSwitchProgressView>(`${OPEN_PAYMENTS_SESSION_BASE}/switch-progress`, { signal })
}

/** The company's Open Payments connections and whether the person has a signer on file (session door only). */
export function fetchOpenPaymentsOverview(signal?: AbortSignal): Promise<OpenPaymentsOverview> {
  return send<OpenPaymentsOverview>(`${OPEN_PAYMENTS_SESSION_BASE}/connections`, { signal })
}

export function fetchOpenPaymentsConnection(connectionId: string, signal?: AbortSignal): Promise<ConnectionView> {
  return sessionOpenPaymentsApi.fetchConnection(connectionId, signal)
}

export function createOpenPaymentsConnection(input: CreateConnectionInput): Promise<CreateConnectionResult> {
  return sessionOpenPaymentsApi.createConnection(input)
}

/** The poll repeats the typed personnummer: the bank wants the PSU named on every call about the consent. */
export function pollOpenPaymentsConnection(connectionId: string, signal?: AbortSignal, signer: Pick<SignerInput, 'personal_number' | 'psu_authoriser_id'> = {}): Promise<ConnectionPoll> {
  return sessionOpenPaymentsApi.pollConnection(connectionId, signal, signer)
}

export function restartOpenPaymentsConnection(connectionId: string, signer: SignerInput = {}): Promise<CreateConnectionResult> {
  return sessionOpenPaymentsApi.restartConnection(connectionId, signer)
}

export function selectOpenPaymentsAccounts(connectionId: string, accounts: AccountSelection[], signer: SignerInput = {}): Promise<SelectAccountsResult> {
  return sessionOpenPaymentsApi.selectAccounts(connectionId, accounts, signer)
}

export function syncOpenPaymentsConnection(connectionId: string): Promise<SyncResult> {
  return sessionOpenPaymentsApi.syncConnection(connectionId)
}

export function deleteOpenPaymentsConnection(connectionId: string): Promise<{ connection_id: string }> {
  return sessionOpenPaymentsApi.deleteConnection(connectionId)
}
