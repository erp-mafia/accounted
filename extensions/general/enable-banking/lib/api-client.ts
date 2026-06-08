/**
 * Enable Banking API integration for PSD2 bank connections
 *
 * Documentation: https://enablebanking.com/docs/api/reference/
 *
 * Flow:
 * 1. POST /auth → { url, authorization_id }
 * 2. User redirects to URL, authenticates with bank
 * 3. Callback receives ?code=XXX&state=YYY
 * 4. POST /sessions { code } → { session_id, accounts }
 * 5. GET /accounts/{uid}/balances
 * 6. GET /accounts/{uid}/transactions
 */

import { getAuthorizationHeader } from './jwt'
import { deriveTransactionLabel } from './transaction-label'
import { FALLBACK_DESCRIPTION } from '@/lib/transactions/external-id'

// Prefer _PRODUCTION variant; sandbox uses api.tilisy.com, production uses api.enablebanking.com
const ENABLE_BANKING_API_URL =
  process.env.ENABLE_BANKING_API_URL_PRODUCTION ||
  process.env.ENABLE_BANKING_API_URL ||
  'https://api.enablebanking.com'

// Types

export interface ASPSP {
  name: string
  country: string
  logo?: string
  bic?: string
  beta?: boolean
  max_consent_validity?: number
  available_auth_methods?: AuthMethod[]
}

export interface AuthMethod {
  name: string
  title?: string
  psu_types?: ('personal' | 'business')[]
}

export interface AuthResponse {
  url: string
  authorization_id: string
}

export interface SessionResponse {
  session_id: string
  access: {
    valid_until: string
  }
  accounts: AccountInfo[]
  aspsp: {
    name: string
    country: string
  }
  psu_type: string
}

export interface AccountInfo {
  uid: string
  account_id?: {
    iban?: string
    bban?: string
    other?: string
  }
  name?: string
  product?: string
  currency: string
  identification_hash?: string
}

export interface Balance {
  balance_amount: {
    amount: string
    currency: string
  }
  balance_type: string
  reference_date?: string
  last_change_date_time?: string
}

export interface BalanceResponse {
  balances: Balance[]
}

export interface Transaction {
  entry_reference?: string
  transaction_id?: string
  booking_date?: string
  value_date?: string
  transaction_amount: {
    amount: string
    currency: string
  }
  credit_debit_indicator?: 'CRDT' | 'DBIT'  // CRDT = credit (income), DBIT = debit (expense)
  creditor_name?: string
  creditor_account?: {
    iban?: string
    bban?: string
  }
  creditor?: {
    name?: string
  }
  debtor_name?: string
  debtor_account?: {
    iban?: string
    bban?: string
  }
  debtor?: {
    name?: string
  }
  remittance_information?: string[]
  merchant_category_code?: string
  bank_transaction_code?: string
  proprietary_bank_transaction_code?: string
}

export interface TransactionsResponse {
  transactions: Transaction[]
  continuation_key?: string
}

/**
 * Strategy for how Enable Banking fetches transactions from the upstream ASPSP.
 * - 'default' — fast path, may return only the most recent window even if date_from is older
 * - 'longest' — fetch the longest available history (up to PSD2 90-day max), slower
 *
 * When omitted, Enable Banking applies its default strategy.
 */
export type TransactionsFetchStrategy = 'default' | 'longest'

// Legacy types for backward compatibility
export interface Bank {
  id: string
  name: string
  bic?: string
  countries: string[]
  logo_url?: string
}

export interface BankTransaction {
  id: string
  date: string
  booking_date: string
  amount: number
  currency: string
  description: string
  counterparty_name?: string
  counterparty_account?: string
  reference?: string
  merchant_category_code?: string
  // ISO 20022 / proprietary transaction codes — carried through so the
  // description fallback can derive a meaningful Swedish label when remittance
  // text and a counterparty name are both absent. See deriveTransactionLabel.
  bank_transaction_code?: string
  proprietary_bank_transaction_code?: string
}

// Constants
const FETCH_TIMEOUT_MS = 15_000
const MAX_RETRIES = 2
const RETRY_DELAY_MS = 1000
const MAX_PAGINATION_PAGES = 100
const DEFAULT_PAGE_SIZE = 500

/**
 * Thrown by getAccountTransactions on a non-OK response. Carries the HTTP
 * status and raw body so the pagination caller (getAllTransactions) can run the
 * same first-page strategy/window fallbacks as getAllTransactionsWithRaw. The
 * message is identical to the previous plain Error for back-compat.
 */
class TransactionsFetchError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`Failed to get transactions (${status}): ${body}`)
    this.name = 'TransactionsFetchError'
  }
}

// API Helper

async function authenticatedFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${ENABLE_BANKING_API_URL}${endpoint}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Authorization': getAuthorizationHeader(),
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    return response
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Retry wrapper for idempotent read operations.
 * Retries on 429, 502, 503, 504, and AbortError (timeout).
 */
async function authenticatedFetchWithRetry(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await authenticatedFetch(endpoint, options)
      if (attempt < MAX_RETRIES && [429, 502, 503, 504].includes(response.status)) {
        console.warn(`[enable-banking] Retrying ${endpoint} (attempt ${attempt + 1}/${MAX_RETRIES})`, {
          status: response.status,
          statusText: response.statusText,
        })
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)))
        continue
      }
      return response
    } catch (error: unknown) {
      const isAbort = error instanceof Error && error.name === 'AbortError'
      if (attempt < MAX_RETRIES && isAbort) {
        console.warn(`[enable-banking] Request timeout, retrying ${endpoint} (attempt ${attempt + 1}/${MAX_RETRIES})`)
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)))
        continue
      }
      console.error(`[enable-banking] Request failed for ${endpoint}`, {
        attempt,
        error: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
        isTimeout: isAbort,
      })
      throw error
    }
  }
  // Unreachable, but satisfies TypeScript
  throw new Error('Max retries exceeded')
}

// API Functions

/**
 * Get list of supported banks (ASPSPs) for a country
 */
export async function getASPSPs(country: string = 'SE', psuType?: 'personal' | 'business'): Promise<ASPSP[]> {
  const resolvedPsuType = psuType || process.env.ENABLE_BANKING_PSU_TYPE || 'business'
  const isSandbox = ENABLE_BANKING_API_URL.includes('tilisy')
  const params = new URLSearchParams({
    country,
    sandbox: String(isSandbox),
    psu_type: resolvedPsuType,
  })
  const response = await authenticatedFetchWithRetry(`/aspsps?${params.toString()}`)

  if (!response.ok) {
    const body = await response.text()
    console.error('[enable-banking] getASPSPs failed', {
      status: response.status,
      statusText: response.statusText,
      body,
      country,
      psuType: resolvedPsuType,
      sandbox: isSandbox,
      apiUrl: ENABLE_BANKING_API_URL,
    })
    throw new Error(`Failed to fetch banks (${response.status})`)
  }

  const data = await response.json()
  return data.aspsps || []
}

/**
 * Get list of supported banks (legacy format for backward compatibility)
 */
export async function getSupportedBanks(): Promise<Bank[]> {
  try {
    const aspsps = await getASPSPs('SE')

    return aspsps.map((aspsp) => ({
      id: `${aspsp.name.toLowerCase().replace(/\s+/g, '-')}-se`,
      name: aspsp.name,
      bic: aspsp.bic,
      countries: [aspsp.country],
      logo_url: aspsp.logo,
    }))
  } catch (error) {
    console.error('Error fetching banks:', error)
    // Return fallback list
    return [
      { id: 'nordea-se', name: 'Nordea', bic: 'NDEASESS', countries: ['SE'] },
      { id: 'seb-se', name: 'SEB', bic: 'ESSESESS', countries: ['SE'] },
      { id: 'swedbank-se', name: 'Swedbank', bic: 'SWEDSESS', countries: ['SE'] },
      { id: 'handelsbanken-se', name: 'Handelsbanken', bic: 'HANDSESS', countries: ['SE'] },
    ]
  }
}

/**
 * Start bank authorization flow
 *
 * @param aspspName - The name of the ASPSP (bank) exactly as returned from /aspsps
 * @param aspspCountry - The country code (e.g., 'SE')
 * @param redirectUrl - URL to redirect user after bank authorization
 * @param state - State parameter returned in callback (e.g., user ID)
 * @param psuType - Type of user: 'personal' or 'business'
 */
export async function startAuthorization(
  aspspName: string,
  aspspCountry: string,
  redirectUrl: string,
  state: string,
  psuType: 'personal' | 'business' = 'personal'
): Promise<AuthResponse> {
  // Calculate consent validity (90 days)
  const validUntil = new Date()
  validUntil.setDate(validUntil.getDate() + 90)

  const requestBody = {
    access: {
      valid_until: validUntil.toISOString()
    },
    aspsp: {
      name: aspspName,
      country: aspspCountry
    },
    state,
    redirect_url: redirectUrl,
    psu_type: psuType
  }

  const response = await authenticatedFetch('/auth', {
    method: 'POST',
    body: JSON.stringify(requestBody)
  })

  if (!response.ok) {
    const body = await response.text()
    console.error('[enable-banking] startAuthorization failed', {
      status: response.status,
      statusText: response.statusText,
      body,
      aspspName,
      aspspCountry,
      psuType,
      redirectUrl,
      apiUrl: ENABLE_BANKING_API_URL,
      requestBody: JSON.stringify(requestBody),
    })
    throw new Error(`Failed to start bank connection (${response.status}): ${body}`)
  }

  return response.json()
}

/**
 * Create a session after user completes bank authorization
 *
 * @param code - The authorization code from callback
 */
export async function createSession(code: string): Promise<SessionResponse> {
  const response = await authenticatedFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({ code })
  })

  if (!response.ok) {
    const body = await response.text()
    console.error('[enable-banking] createSession failed', {
      status: response.status,
      statusText: response.statusText,
      body,
      hasCode: !!code,
      codeLength: code?.length,
      apiUrl: ENABLE_BANKING_API_URL,
    })
    throw new Error(`Failed to create bank session (${response.status}): ${body}`)
  }

  return response.json()
}

/**
 * Get session details
 *
 * @param sessionId - The session ID
 */
export async function getSession(sessionId: string): Promise<SessionResponse> {
  const response = await authenticatedFetchWithRetry(`/sessions/${sessionId}`)

  if (!response.ok) {
    const body = await response.text()
    console.error('[enable-banking] getSession failed', {
      status: response.status,
      statusText: response.statusText,
      body,
      sessionId,
    })
    throw new Error(`Failed to get session (${response.status}): ${body}`)
  }

  return response.json()
}

/**
 * Delete/revoke a session
 *
 * @param sessionId - The session ID to revoke
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const response = await authenticatedFetch(`/sessions/${sessionId}`, {
    method: 'DELETE'
  })

  if (!response.ok) {
    const body = await response.text()
    console.error('[enable-banking] deleteSession failed', {
      status: response.status,
      statusText: response.statusText,
      body,
      sessionId,
    })
    throw new Error(`Failed to revoke session (${response.status}): ${body}`)
  }
}

/**
 * Get account balances
 *
 * @param accountUid - The account UID (from session.accounts[].uid)
 */
export async function getAccountBalances(accountUid: string): Promise<Balance[]> {
  const response = await authenticatedFetchWithRetry(`/accounts/${accountUid}/balances`)

  if (!response.ok) {
    const body = await response.text()
    console.error('[enable-banking] getAccountBalances failed', {
      status: response.status,
      statusText: response.statusText,
      body,
      accountUid,
    })
    throw new Error(`Failed to get account balances (${response.status}): ${body}`)
  }

  const data: BalanceResponse = await response.json()
  return data.balances || []
}

/**
 * Get account balance (returns booked balance amount)
 */
export async function getAccountBalance(
  accountUid: string
): Promise<{ amount: number; date: string }> {
  const balances = await getAccountBalances(accountUid)

  // Prefer closingBooked, then expected, then first available
  const balance =
    balances.find(b => b.balance_type === 'closingBooked') ||
    balances.find(b => b.balance_type === 'expected') ||
    balances[0]

  if (!balance) {
    return { amount: 0, date: new Date().toISOString().split('T')[0] }
  }

  return {
    amount: parseFloat(balance.balance_amount.amount),
    date: balance.reference_date || new Date().toISOString().split('T')[0]
  }
}

/**
 * Get account transactions
 *
 * @param accountUid - The account UID
 * @param dateFrom - Start date (YYYY-MM-DD)
 * @param dateTo - End date (YYYY-MM-DD)
 * @param continuationKey - Pagination key from previous response
 */
export async function getAccountTransactions(
  accountUid: string,
  dateFrom?: string,
  dateTo?: string,
  continuationKey?: string,
  strategy?: TransactionsFetchStrategy
): Promise<TransactionsResponse> {
  const params = new URLSearchParams()
  if (dateFrom) params.set('date_from', dateFrom)
  if (dateTo) params.set('date_to', dateTo)
  if (continuationKey) params.set('continuation_key', continuationKey)
  if (strategy) params.set('strategy', strategy)
  params.set('limit', String(DEFAULT_PAGE_SIZE))

  const queryString = params.toString()
  const endpoint = `/accounts/${accountUid}/transactions${queryString ? `?${queryString}` : ''}`

  const response = await authenticatedFetchWithRetry(endpoint)

  if (!response.ok) {
    const body = await response.text()
    console.error('[enable-banking] getAccountTransactions failed', {
      status: response.status,
      statusText: response.statusText,
      body,
      accountUid,
      dateFrom,
      dateTo,
      strategy,
      hasContinuationKey: !!continuationKey,
    })
    throw new TransactionsFetchError(response.status, body)
  }

  return response.json()
}

/**
 * Get all transactions with pagination
 */
export async function getAllTransactions(
  accountUid: string,
  dateFrom?: string,
  dateTo?: string,
  strategy?: TransactionsFetchStrategy
): Promise<Transaction[]> {
  const allTransactions: Transaction[] = []
  let continuationKey: string | undefined
  let page = 0
  let activeStrategy = strategy
  // date_from is narrowed in place when the ASPSP rejects the window (below).
  let activeDateFrom = dateFrom

  while (true) {
    let response: TransactionsResponse
    try {
      response = await getAccountTransactions(
        accountUid,
        activeDateFrom,
        dateTo,
        continuationKey,
        activeStrategy
      )
    } catch (err) {
      // Apply the same first-page recovery as getAllTransactionsWithRaw. Only
      // TransactionsFetchError carries the status/body needed to decide;
      // network errors and the like propagate untouched.
      if (err instanceof TransactionsFetchError) {
        const recovery = planFirstPageRecovery({
          status: err.status,
          body: err.body,
          page,
          hasContinuationKey: !!continuationKey,
          activeStrategy,
          activeDateFrom,
          dateTo,
        })
        if (recovery.type === 'drop-strategy') {
          console.warn('[enable-banking] strategy rejected by API, retrying without strategy', {
            accountUid,
            strategy: activeStrategy,
            body: err.body,
          })
          activeStrategy = undefined
          continue
        }
        if (recovery.type === 'narrow') {
          console.warn('[enable-banking] ASPSP rejected history window, retrying with narrower date_from', {
            accountUid,
            previousDateFrom: activeDateFrom,
            nextDateFrom: recovery.dateFrom,
            dateTo,
            body: err.body,
          })
          activeDateFrom = recovery.dateFrom
          continue
        }
      }
      throw err
    }

    allTransactions.push(...response.transactions)
    continuationKey = response.continuation_key
    page++

    if (page >= MAX_PAGINATION_PAGES) {
      console.warn(`[enable-banking] Pagination cap reached (${MAX_PAGINATION_PAGES} pages) for account ${accountUid}`)
      break
    }
    if (!continuationKey) break
  }

  return allTransactions
}

/**
 * Lookback windows (days before date_to) we step through when an ASPSP rejects
 * the requested transaction history. Descending so each fallback yields a
 * strictly narrower window. PSD2 obliges banks to ~90 days without fresh SCA;
 * the smaller rungs cover banks that cap below that.
 */
const ASPSP_HISTORY_FALLBACK_DAYS = [90, 60, 30] as const

/**
 * Enable Banking wraps upstream-bank failures in a generic envelope, e.g.
 * {"code":400,"message":"Error interacting with ASPSP","error":"ASPSP_ERROR"}.
 * A too-wide history window is the most common trigger — see the date-narrowing
 * fallback in getAllTransactionsWithRaw.
 */
function isAspspError(body: string): boolean {
  return body.includes('ASPSP_ERROR') || body.includes('interacting with ASPSP')
}

/**
 * Given the date_from we just tried, return the next strictly-narrower
 * date_from from ASPSP_HISTORY_FALLBACK_DAYS, anchored to date_to. Returns
 * undefined when no narrower window remains (or date_to is missing), which
 * ends the retry loop. The "strictly narrower" guard keeps the loop monotonic
 * and terminating even if the original window was already short.
 */
function nextNarrowerDateFrom(
  currentDateFrom: string | undefined,
  dateTo: string | undefined
): string | undefined {
  if (!dateTo) return undefined
  const anchor = new Date(`${dateTo}T00:00:00Z`)
  if (!Number.isFinite(anchor.getTime())) return undefined

  for (const days of ASPSP_HISTORY_FALLBACK_DAYS) {
    const candidate = new Date(anchor.getTime() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]
    if (!currentDateFrom || candidate > currentDateFrom) {
      return candidate
    }
  }
  return undefined
}

/**
 * First-page recovery policy shared by getAllTransactions and
 * getAllTransactionsWithRaw, so the two pagination loops can't drift. Fallbacks
 * apply only to the very first request (page 0, no continuation_key) — a
 * continuation_key is scoped to the window/strategy that produced it, so the
 * query is never rewritten mid-pagination.
 *
 *  - 'drop-strategy' — an unsupported strategy enum: retry the same window.
 *  - 'narrow'        — the ASPSP rejected the history window: retry with a
 *                      narrower date_from (the bank caps history below the ask).
 *  - 'give-up'       — nothing left to try; the caller should rethrow.
 */
type FirstPageRecovery =
  | { type: 'drop-strategy' }
  | { type: 'narrow'; dateFrom: string }
  | { type: 'give-up' }

function planFirstPageRecovery(args: {
  status: number
  body: string
  page: number
  hasContinuationKey: boolean
  activeStrategy: TransactionsFetchStrategy | undefined
  activeDateFrom: string | undefined
  dateTo: string | undefined
}): FirstPageRecovery {
  const { status, body, page, hasContinuationKey, activeStrategy, activeDateFrom, dateTo } = args
  if (status !== 400 || page !== 0 || hasContinuationKey) return { type: 'give-up' }
  // Drop an unsupported strategy first — preserves the full requested window.
  if (activeStrategy) return { type: 'drop-strategy' }
  // Then handle the ASPSP rejecting the window itself (e.g. Danske past ~90
  // days): step date_from toward date_to so a partial sync survives.
  if (isAspspError(body)) {
    const dateFrom = nextNarrowerDateFrom(activeDateFrom, dateTo)
    if (dateFrom) return { type: 'narrow', dateFrom }
  }
  return { type: 'give-up' }
}

/**
 * Get all transactions with raw JSON responses for archival.
 * Returns both parsed transactions and the raw response strings.
 *
 * If `strategy` is provided and the API rejects it with a 400 on the first
 * request, retry once without `strategy` so unknown enum values can't break
 * the sync. Logs a warning when the fallback fires.
 *
 * If the ASPSP then still rejects the first page with an ASPSP_ERROR (typically
 * a history window beyond the bank's PSD2 limit, e.g. Danske past ~90 days),
 * progressively narrow date_from toward date_to (90→60→30 days) so a partial
 * sync of the recent window survives instead of failing outright. Logs a
 * warning on each narrowing.
 */
export async function getAllTransactionsWithRaw(
  accountUid: string,
  dateFrom?: string,
  dateTo?: string,
  strategy?: TransactionsFetchStrategy
): Promise<{ transactions: Transaction[]; rawPages: string[] }> {
  const allTransactions: Transaction[] = []
  const rawPages: string[] = []
  let continuationKey: string | undefined
  let page = 0
  let activeStrategy = strategy
  // date_from is narrowed in place when the ASPSP rejects the window (below).
  let activeDateFrom = dateFrom

  while (true) {
    const params = new URLSearchParams()
    if (activeDateFrom) params.set('date_from', activeDateFrom)
    if (dateTo) params.set('date_to', dateTo)
    if (continuationKey) params.set('continuation_key', continuationKey)
    if (activeStrategy) params.set('strategy', activeStrategy)
    params.set('limit', String(DEFAULT_PAGE_SIZE))

    const queryString = params.toString()
    const endpoint = `/accounts/${accountUid}/transactions${queryString ? `?${queryString}` : ''}`

    const response = await authenticatedFetchWithRetry(endpoint)

    if (!response.ok) {
      const body = await response.text()
      const recovery = planFirstPageRecovery({
        status: response.status,
        body,
        page,
        hasContinuationKey: !!continuationKey,
        activeStrategy,
        activeDateFrom,
        dateTo,
      })
      if (recovery.type === 'drop-strategy') {
        console.warn('[enable-banking] strategy rejected by API, retrying without strategy', {
          accountUid,
          strategy: activeStrategy,
          body,
        })
        activeStrategy = undefined
        continue
      }
      if (recovery.type === 'narrow') {
        console.warn('[enable-banking] ASPSP rejected history window, retrying with narrower date_from', {
          accountUid,
          previousDateFrom: activeDateFrom,
          nextDateFrom: recovery.dateFrom,
          dateTo,
          body,
        })
        activeDateFrom = recovery.dateFrom
        continue
      }
      console.error('[enable-banking] getAllTransactionsWithRaw failed', {
        status: response.status,
        statusText: response.statusText,
        body,
        accountUid,
        dateFrom: activeDateFrom,
        dateTo,
        strategy: activeStrategy,
        page,
        hasContinuationKey: !!continuationKey,
      })
      throw new Error(`Failed to get transactions (${response.status}): ${body}`)
    }

    const rawText = await response.text()
    rawPages.push(rawText)

    const data: TransactionsResponse = JSON.parse(rawText)
    allTransactions.push(...data.transactions)
    continuationKey = data.continuation_key
    page++

    if (page >= MAX_PAGINATION_PAGES) {
      console.warn(`[enable-banking] Pagination cap reached (${MAX_PAGINATION_PAGES} pages) for account ${accountUid}`)
      break
    }
    if (!continuationKey) break
  }

  return { transactions: allTransactions, rawPages }
}

/**
 * Convert Enable Banking transaction to legacy format
 */
export function convertTransaction(tx: Transaction, accountCurrency: string): BankTransaction {
  const rawAmount = parseFloat(tx.transaction_amount.amount)

  // Use credit_debit_indicator to determine sign
  // CRDT = credit (money in) = positive
  // DBIT = debit (money out) = negative
  const isCredit = tx.credit_debit_indicator === 'CRDT'
  const amount = isCredit ? Math.abs(rawAmount) : -Math.abs(rawAmount)

  // Get counterparty name from creditor/debtor objects or direct fields
  const creditorName = tx.creditor?.name || tx.creditor_name
  const debtorName = tx.debtor?.name || tx.debtor_name

  return {
    id: tx.entry_reference || tx.transaction_id || `${tx.booking_date}_${rawAmount}`,
    date: tx.value_date || tx.booking_date || new Date().toISOString().split('T')[0],
    booking_date: tx.booking_date || tx.value_date || new Date().toISOString().split('T')[0],
    amount,
    currency: tx.transaction_amount.currency || accountCurrency,
    // Fallback chain: bank's payment message → counterparty name → a Swedish
    // label derived from the ISO 20022 / MCC codes the bank DID send (card
    // purchases, ATM, fees, interest) → 'Okänd transaktion'. The final fallback
    // is also normalized at the ingest boundary, so any leftover lands as the
    // same Swedish neutral.
    description: tx.remittance_information?.filter(r => r.trim()).join(' ') ||
                 (isCredit ? debtorName : creditorName) ||
                 deriveTransactionLabel({
                   bankTransactionCode: tx.bank_transaction_code,
                   proprietaryBankTransactionCode: tx.proprietary_bank_transaction_code,
                   mcc: tx.merchant_category_code,
                   isCredit,
                 }) ||
                 FALLBACK_DESCRIPTION,
    counterparty_name: isCredit ? debtorName : creditorName,
    counterparty_account: isCredit
      ? tx.debtor_account?.iban || tx.debtor_account?.bban
      : tx.creditor_account?.iban || tx.creditor_account?.bban,
    merchant_category_code: tx.merchant_category_code,
    bank_transaction_code: tx.bank_transaction_code,
    proprietary_bank_transaction_code: tx.proprietary_bank_transaction_code,
  }
}

/**
 * Get transactions in legacy format
 */
export async function getTransactions(
  accountUid: string,
  fromDate?: string,
  toDate?: string,
  accountCurrency: string = 'SEK'
): Promise<BankTransaction[]> {
  const transactions = await getAllTransactions(accountUid, fromDate, toDate)
  return transactions.map(tx => convertTransaction(tx, accountCurrency))
}

/**
 * Whether the current configuration targets the sandbox API
 */
export function isSandboxMode(): boolean {
  return ENABLE_BANKING_API_URL.includes('tilisy')
}

// Utility functions

/**
 * Check if consent is expiring soon (within 7 days)
 */
export function isConsentExpiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false

  const expiryDate = new Date(expiresAt)
  const warningDate = new Date()
  warningDate.setDate(warningDate.getDate() + 7)

  return expiryDate <= warningDate
}

/**
 * Get days until consent expires
 */
export function getDaysUntilExpiry(expiresAt: string | null): number | null {
  if (!expiresAt) return null

  const expiryDate = new Date(expiresAt)
  const now = new Date()
  const diffTime = expiryDate.getTime() - now.getTime()
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

  return Math.max(0, diffDays)
}
