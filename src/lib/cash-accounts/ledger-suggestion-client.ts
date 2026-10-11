/**
 * Browser side of the ledger-account suggestions (crm#1066): read them, and
 * apply one through the bank picker's own save.
 *
 * Applying is two requests that already exist, in the order the user would
 * make them by hand:
 *   1. PATCH /api/extensions/ext/enable-banking/accounts with the suggestion's
 *      `selection`: the request the bank picker (AccountPickerDialog) sends,
 *      so save_bank_account_selection stays the one writer of a bank
 *      account's ledger account and its named refusals reach the user as they
 *      do from the picker.
 *   2. POST /api/reconciliation/bank/run { account_number }: the verifikat
 *      matcher of Bankavstämning, once per ledger account a bank account
 *      moved onto. It links the bank transactions to the verifikat that
 *      already describe them, at the unattended floor (exact matches are
 *      linked, weaker ones become suggestions to review). The picker's save
 *      runs no matching for a connection that is already active, and without
 *      it the transactions would stay unbooked after the change. Only the
 *      moved accounts are matched: nothing else in the company is touched.
 *
 * Client-only (relative URLs, an in-memory cache). No React here: the hook
 * is lib/hooks/use-bank-ledger-suggestions.ts.
 */

import type { LedgerSuggestionView } from '@/lib/cash-accounts/ledger-suggestion-view'

const SUGGESTIONS_URL = '/api/cash-accounts/ledger-suggestions'
const SELECTION_URL = '/api/extensions/ext/enable-banking/accounts'
const MATCHER_URL = '/api/reconciliation/bank/run'

/**
 * How long an answer is reused. The read walks the ledger, the answer changes
 * only when the books or the mapping do, and the notice is not urgent: one
 * read per company every few minutes is enough, however often the user moves
 * between Transaktioner and the settings.
 */
const CACHE_MS = 5 * 60 * 1000

const cache = new Map<string, { at: number; request: Promise<LedgerSuggestionView[]> }>()

function cacheKey(companyId: string, connectionId: string | undefined): string {
  return `${companyId}:${connectionId ?? ''}`
}

async function request(connectionId: string | undefined): Promise<LedgerSuggestionView[]> {
  const url = connectionId ? `${SUGGESTIONS_URL}?connection_id=${encodeURIComponent(connectionId)}` : SUGGESTIONS_URL
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Ledger suggestions: ${response.status}`)
  const body = (await response.json()) as { data?: { suggestions?: LedgerSuggestionView[] } }
  return body.data?.suggestions ?? []
}

/**
 * The company's suggestions, or one bank connection's. A failed read is not
 * cached and rejects: callers show nothing, which is the state before this
 * feature existed.
 */
export function fetchLedgerSuggestions(
  companyId: string,
  options: { connectionId?: string; fresh?: boolean } = {},
): Promise<LedgerSuggestionView[]> {
  const key = cacheKey(companyId, options.connectionId)
  const hit = cache.get(key)
  if (hit && !options.fresh && Date.now() - hit.at < CACHE_MS) return hit.request
  const pending = request(options.connectionId)
  cache.set(key, { at: Date.now(), request: pending })
  pending.catch(() => {
    if (cache.get(key)?.request === pending) cache.delete(key)
  })
  return pending
}

const listeners = new Set<() => void>()

/**
 * Forget every cached answer and tell the mounted readers to read again: the
 * mapping changed (a suggestion applied, a bank picker save).
 */
export function forgetLedgerSuggestions(): void {
  cache.clear()
  for (const listener of [...listeners]) listener()
}

/** Called whenever the answers were forgotten. Returns the unsubscribe. */
export function onLedgerSuggestionsForgotten(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Link the bank transactions of the bank accounts that now book on
 * `ledgerAccounts` to the verifikat that already describe them: the existing
 * matcher run of Bankavstämning, once per ledger account. Null when a run
 * failed; the change of ledger account stands either way.
 */
export async function relinkBankTransactions(
  ledgerAccounts: readonly string[],
): Promise<{ linked: number; suggested: number } | null> {
  let linked = 0
  let suggested = 0
  try {
    for (const accountNumber of new Set(ledgerAccounts)) {
      const response = await fetch(MATCHER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_number: accountNumber }),
      })
      if (!response.ok) return null
      const body = (await response.json()) as { data?: { applied?: number; suggested?: number } }
      linked += body.data?.applied ?? 0
      suggested += body.data?.suggested ?? 0
    }
  } catch {
    return null
  }
  return { linked, suggested }
}

export type ApplyLedgerSuggestionResult =
  /** Saved. `relinked` is null when the matching could not run afterwards. */
  | { status: 'applied'; relinked: { linked: number; suggested: number } | null }
  /** The save refused or failed and nothing changed. `reason` is the server's sentence, when it gave one. */
  | { status: 'refused'; reason: string | null }
  /** The suggestion no longer holds (the mapping or the books changed since it was shown). */
  | { status: 'gone' }

/**
 * Apply the suggestion with this id. It is read again first, so the save
 * carries the connection's account selection as it is now, not as it was when
 * the notice rendered.
 */
export async function applyLedgerSuggestion(companyId: string, id: string): Promise<ApplyLedgerSuggestionResult> {
  let current: LedgerSuggestionView | undefined
  try {
    current = (await fetchLedgerSuggestions(companyId, { fresh: true })).find((suggestion) => suggestion.id === id)
  } catch {
    return { status: 'refused', reason: null }
  }
  if (!current || !current.one_click || !current.selection) {
    forgetLedgerSuggestions()
    return { status: 'gone' }
  }

  let response: Response
  try {
    response = await fetch(SELECTION_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(current.selection),
    })
  } catch {
    return { status: 'refused', reason: null }
  }
  if (!response.ok) {
    // Route validation answers { error: string }; a database refusal answers
    // the envelope { error: { code, message } } with the sentence that names
    // the bank account (lib/cash-accounts/selection-refusal.ts).
    const body = (await response.json().catch(() => null)) as { error?: string | { message?: string } } | null
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message
    return { status: 'refused', reason: typeof message === 'string' && message ? message : null }
  }

  forgetLedgerSuggestions()
  return {
    status: 'applied',
    relinked: await relinkBankTransactions(current.selection.account_mappings.map((mapping) => mapping.ledger_account)),
  }
}
