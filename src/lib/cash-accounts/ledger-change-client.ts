/**
 * Browser side of the ledger-account change (crm#1395, crm#1387): preview and
 * apply PATCH /api/bank/connections/:id/ledgers, the one door for every bank
 * connection (lib/cash-accounts/ledger-change.ts). Used by the bank account
 * rows under a connection and by the ledger suggestion's button.
 *
 * Client-only (relative URLs). No React here.
 */

import type { LedgerChangeMove } from '@/lib/cash-accounts/ledger-change'

export type { LedgerChangeMove }

export interface LedgerChangeAccount {
  uid: string
  ledger_account: string
}

/** A refused or failed request: `message` is the server's sentence when it gave one. */
export class LedgerChangeError extends Error {
  constructor(
    readonly reason: string | null,
    readonly status: number,
  ) {
    super(reason ?? `ledger change failed (${status})`)
    this.name = 'LedgerChangeError'
  }
}

function ledgersUrl(connectionId: string, dryRun: boolean): string {
  return `/api/bank/connections/${encodeURIComponent(connectionId)}/ledgers${dryRun ? '?dry_run=true' : ''}`
}

async function send(connectionId: string, accounts: readonly LedgerChangeAccount[], dryRun: boolean): Promise<LedgerChangeMove[]> {
  let response: Response
  try {
    response = await fetch(ledgersUrl(connectionId, dryRun), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accounts }),
    })
  } catch {
    throw new LedgerChangeError(null, 0)
  }
  const body = (await response.json().catch(() => null)) as
    | { data?: { moves?: LedgerChangeMove[] }; error?: string | { message?: string } }
    | null
  if (!response.ok) {
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message
    throw new LedgerChangeError(typeof message === 'string' && message ? message : null, response.status)
  }
  return body?.data?.moves ?? []
}

/** What the change would do: every account that moves, with its booked and unbooked rows. Writes nothing. */
export function previewLedgerChange(connectionId: string, accounts: readonly LedgerChangeAccount[]): Promise<LedgerChangeMove[]> {
  return send(connectionId, accounts, true)
}

/** Make the change. Answers the moves that were made. */
export function applyLedgerChange(connectionId: string, accounts: readonly LedgerChangeAccount[]): Promise<LedgerChangeMove[]> {
  return send(connectionId, accounts, false)
}
