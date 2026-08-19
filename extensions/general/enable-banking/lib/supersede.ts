import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { normalizeIban } from '@/lib/cash-accounts/service'
import { eventBus } from '@/lib/events/bus'
import { deleteSession } from './api-client'
import { countLiveSiblings } from './session-sharing'
import type { StoredAccount } from '../types'

const log = createLogger('enable-banking/supersede')

/**
 * transactions.bank_connection_id is re-pointed id-batch by id-batch instead
 * of one unbounded UPDATE: a long-lived connection can hold years of feed
 * rows, and a single statement over all of them risks the platform statement
 * timeout mid-callback.
 */
const REPOINT_BATCH_SIZE = 500

export interface SupersedeInput {
  companyId: string
  userId: string
  /** The connection that just completed the callback (the survivor). */
  newConnectionId: string
  bankName: string | null
  /** Session the surviving row now holds; a sibling on the SAME session is never revoked at EB. */
  newSessionId: string | null
  /** Accounts the new session returned (for IBAN-overlap matching). */
  newAccounts: readonly StoredAccount[]
}

export interface SupersedeResult {
  /** Sibling rows parked as revoked + superseded_by. */
  supersededIds: string[]
  /**
   * dedup scopes carried from superseded siblings, keyed by normalized IBAN.
   * The caller applies these to the surviving row's accounts_data so a
   * renewal keeps minting the same transaction external_ids.
   */
  dedupScopeByIban: Map<string, string>
}

interface SiblingRow {
  id: string
  status: string
  session_id: string | null
  accounts_data: StoredAccount[] | null
  last_synced_at: string | null
  initial_sync_completed_at: string | null
  initial_sync_requested_from: string | null
  initial_sync_returned_min_date: string | null
  initial_sync_returned_max_date: string | null
  initial_sync_lookback_days: number | null
}

/**
 * Park every older connection row this (re)connect replaces.
 *
 * A renewal performed via the bank list ("Anslut ny bank") used to leave the
 * previous row in 'expired' forever: an eternal "Åtgärd krävs" card, a red
 * status chip, and the transaction history stranded on the dead row so the
 * picker's gap-fill probe read the renewal as a first connect. This helper
 * runs from the OAuth callback after the surviving row is updated:
 *
 * 1. Match siblings (same company, same bank, live-ish status) by IBAN
 *    overlap. An ACTIVE sibling with no overlap is never touched: two logins
 *    at the same bank (e.g. SEB privat + företag) legitimately coexist.
 *    When NEITHER side carries any IBAN, a non-active sibling is matched on
 *    bank identity alone (logged): those rows cannot be proven either way
 *    and leaving them would strand the duplicate forever.
 * 2. Best-effort revoke the sibling's EB session, but only when no other
 *    connection still shares it (countLiveSiblings, same rule as
 *    /disconnect and the reconnect path).
 * 3. Park the row: status 'revoked' (reused deliberately: every existing
 *    filter, ledger-claim release, and cron skip already handles it) plus
 *    superseded_by/superseded_at so it stays distinguishable from a user
 *    disconnect.
 * 4. Re-point the sibling's transactions at the surviving row (feed
 *    metadata only: journal tables are never touched) so gap-fill probes,
 *    per-connection scoping, and "sedan sist" counters keep working.
 * 5. Demote leftover cash_accounts rows to manual, mirroring /disconnect;
 *    the callback's own IBAN mirror then promotes them onto the survivor.
 * 6. Carry sync state (last_synced_at, initial_sync_*) onto the surviving
 *    row when it has none, so neither the cron's first-sync backfill nor
 *    the picker treats a renewal as a first connect.
 *
 * Must run on a service-role client (RLS would hide nothing here, but
 * countLiveSiblings requires it, and the callback already holds one).
 * Idempotent: a re-run finds no live siblings and does nothing.
 */
export async function supersedeSiblingConnections(
  supabase: SupabaseClient,
  input: SupersedeInput,
): Promise<SupersedeResult> {
  const result: SupersedeResult = { supersededIds: [], dedupScopeByIban: new Map() }
  if (!input.bankName) return result

  const { data: siblingRows, error: siblingError } = await supabase
    .from('bank_connections')
    .select(
      'id, status, session_id, accounts_data, last_synced_at, initial_sync_completed_at, initial_sync_requested_from, initial_sync_returned_min_date, initial_sync_returned_max_date, initial_sync_lookback_days',
    )
    .eq('company_id', input.companyId)
    .eq('bank_name', input.bankName)
    .neq('id', input.newConnectionId)
    .in('status', ['active', 'expired', 'error', 'pending_selection'])

  if (siblingError) {
    log.warn('sibling lookup failed, superseding nothing', {
      companyId: input.companyId,
      newConnectionId: input.newConnectionId,
      error: siblingError.message,
    })
    return result
  }
  const siblings = (siblingRows ?? []) as SiblingRow[]
  if (siblings.length === 0) return result

  const newIbans = new Set<string>()
  for (const account of input.newAccounts) {
    const iban = normalizeIban(account.iban)
    if (iban) newIbans.add(iban)
  }

  const superseded: SiblingRow[] = []
  for (const sibling of siblings) {
    const siblingAccounts = sibling.accounts_data ?? []
    const siblingIbans = new Set<string>()
    for (const account of siblingAccounts) {
      const iban = normalizeIban(account.iban)
      if (iban) siblingIbans.add(iban)
    }

    const overlap = [...siblingIbans].some((iban) => newIbans.has(iban))
    if (!overlap) {
      // Without IBAN overlap we cannot prove this is the same account set.
      // An active sibling stays untouched (it may be a genuinely different
      // login at the same bank); a dead sibling is matched on bank identity
      // alone only when NEITHER side carries any IBAN at all.
      const neitherHasIbans = newIbans.size === 0 && siblingIbans.size === 0
      if (sibling.status === 'active' || !neitherHasIbans) {
        log.info('sibling left alone: no IBAN overlap', {
          siblingId: sibling.id,
          siblingStatus: sibling.status,
          newConnectionId: input.newConnectionId,
        })
        continue
      }
      log.warn('superseding no-IBAN sibling on bank identity alone', {
        siblingId: sibling.id,
        siblingStatus: sibling.status,
        newConnectionId: input.newConnectionId,
      })
    }

    // Park the row FIRST, revoke at Enable Banking only after the park
    // succeeded: revoking first and then failing to park would leave a
    // live-looking row whose session is already dead at the bank, with no
    // way back but another full reconnect.
    const { error: updateError } = await supabase
      .from('bank_connections')
      .update({
        status: 'revoked',
        session_id: null,
        oauth_state: null,
        error_message: null,
        superseded_by: input.newConnectionId,
        superseded_at: new Date().toISOString(),
      })
      .eq('id', sibling.id)
      .eq('company_id', input.companyId)

    if (updateError) {
      log.error('failed to park superseded sibling: skipping its EB session revoke', {
        siblingId: sibling.id,
        error: updateError.message,
      })
      continue
    }

    // Best-effort revoke the replaced consent at Enable Banking. Never revoke
    // a session another connection still holds (shared cross-company
    // consents, see lib/session-sharing.ts), and never revoke the session the
    // surviving row itself now carries.
    if (sibling.session_id && sibling.session_id !== input.newSessionId) {
      const stillShared =
        (await countLiveSiblings(supabase, sibling.session_id, sibling.id)) > 0
      if (stillShared) {
        log.info('sibling session shared with other connections: not revoking at EB', {
          siblingId: sibling.id,
        })
      } else {
        try {
          await deleteSession(sibling.session_id)
        } catch (revokeError) {
          log.warn('sibling session revoke skipped (likely already expired)', {
            siblingId: sibling.id,
            message: revokeError instanceof Error ? revokeError.message : String(revokeError),
          })
        }
      }
    }
    superseded.push(sibling)
    result.supersededIds.push(sibling.id)

    // Carry the dedup scope of every IBAN-identified account forward so the
    // surviving row keeps minting the SAME transaction external_ids (the
    // scope may be an old provider uid for accounts whose IBAN appeared
    // later). Only explicit scopes travel: a missing one means the sibling's
    // ids were derived from the IBAN, which the survivor derives identically.
    for (const account of siblingAccounts) {
      const iban = normalizeIban(account.iban)
      if (iban && account.dedup_scope && !result.dedupScopeByIban.has(iban)) {
        result.dedupScopeByIban.set(iban, account.dedup_scope)
      }
    }

    await repointTransactions(supabase, input.companyId, sibling.id, input.newConnectionId)

    // Release the sibling's ledger claims, mirroring /disconnect: the
    // callback's IBAN mirror promotes the (now manual) holders onto the
    // surviving connection so the same bank lands back on its BAS account.
    const { error: demoteError } = await supabase
      .from('cash_accounts')
      .update({ bank_connection_id: null })
      .eq('company_id', input.companyId)
      .eq('bank_connection_id', sibling.id)
    if (demoteError) {
      log.error('failed to release superseded sibling cash_accounts claims', {
        siblingId: sibling.id,
        error: demoteError.message,
      })
    }

    try {
      await eventBus.emit({
        type: 'bank_connection.superseded',
        payload: {
          connectionId: sibling.id,
          supersededById: input.newConnectionId,
          bankName: input.bankName,
          userId: input.userId,
          companyId: input.companyId,
        },
      })
    } catch (emitError) {
      log.error('failed to emit bank_connection.superseded', emitError as Error, {
        siblingId: sibling.id,
      })
    }
  }

  if (superseded.length > 0) {
    await carrySyncStateForward(supabase, input.newConnectionId, superseded)
    log.info('superseded sibling connections', {
      newConnectionId: input.newConnectionId,
      supersededIds: result.supersededIds,
    })
  }

  return result
}

/**
 * Copy sync bookkeeping from the superseded rows onto the survivor when the
 * survivor has none: without this the cron's first-sync backfill path
 * (gated on initial_sync_completed_at IS NULL) re-runs a deep history pull
 * for a bank that was already backfilled, which is one of the duplicate
 * floods this module exists to stop.
 */
async function carrySyncStateForward(
  supabase: SupabaseClient,
  newConnectionId: string,
  superseded: readonly SiblingRow[],
): Promise<void> {
  const { data: newRow, error: newRowError } = await supabase
    .from('bank_connections')
    .select('last_synced_at, initial_sync_completed_at')
    .eq('id', newConnectionId)
    .single()

  if (newRowError || !newRow) {
    log.warn('could not read surviving row for sync-state carry-forward', {
      newConnectionId,
      error: newRowError?.message,
    })
    return
  }
  const survivor = newRow as { last_synced_at: string | null; initial_sync_completed_at: string | null }

  const maxLastSynced = superseded
    .map((s) => s.last_synced_at)
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop()

  const donor = superseded
    .filter((s) => Boolean(s.initial_sync_completed_at))
    .sort((a, b) => (a.initial_sync_completed_at! < b.initial_sync_completed_at! ? 1 : -1))[0]

  const carryLastSynced = !survivor.last_synced_at && maxLastSynced
  const carryInitialSync = !survivor.initial_sync_completed_at && donor
  if (!carryLastSynced && !carryInitialSync) return

  // Payloads stay object literals per branch (never a built-up/spread record)
  // so the no-phantom-columns guard can verify the column names.
  const { error: carryError } =
    carryLastSynced && carryInitialSync
      ? await supabase
          .from('bank_connections')
          .update({
            last_synced_at: maxLastSynced,
            initial_sync_completed_at: donor!.initial_sync_completed_at,
            initial_sync_requested_from: donor!.initial_sync_requested_from,
            initial_sync_returned_min_date: donor!.initial_sync_returned_min_date,
            initial_sync_returned_max_date: donor!.initial_sync_returned_max_date,
            initial_sync_lookback_days: donor!.initial_sync_lookback_days,
          })
          .eq('id', newConnectionId)
      : carryLastSynced
        ? await supabase
            .from('bank_connections')
            .update({ last_synced_at: maxLastSynced })
            .eq('id', newConnectionId)
        : await supabase
            .from('bank_connections')
            .update({
              initial_sync_completed_at: donor!.initial_sync_completed_at,
              initial_sync_requested_from: donor!.initial_sync_requested_from,
              initial_sync_returned_min_date: donor!.initial_sync_returned_min_date,
              initial_sync_returned_max_date: donor!.initial_sync_returned_max_date,
              initial_sync_lookback_days: donor!.initial_sync_lookback_days,
            })
            .eq('id', newConnectionId)

  if (carryError) {
    log.error('failed to carry sync state onto surviving connection', {
      newConnectionId,
      error: carryError.message,
    })
  }
}

/**
 * Move the superseded row's feed rows onto the survivor. This is transaction
 * METADATA (the plain ON DELETE SET NULL FK), never journal tables: no BFL
 * immutability or period-lock trigger is in play. Batched by id so a
 * years-long feed cannot blow the statement timeout inside the callback.
 */
async function repointTransactions(
  supabase: SupabaseClient,
  companyId: string,
  fromConnectionId: string,
  toConnectionId: string,
): Promise<void> {
  let total = 0
  for (;;) {
    const { data: rows, error: selectError } = await supabase
      .from('transactions')
      .select('id')
      .eq('company_id', companyId)
      .eq('bank_connection_id', fromConnectionId)
      .limit(REPOINT_BATCH_SIZE)

    if (selectError) {
      log.error('transaction re-point select failed', {
        fromConnectionId,
        error: selectError.message,
      })
      break
    }
    const ids = ((rows ?? []) as Array<{ id: string }>).map((r) => r.id)
    if (ids.length === 0) break

    const { error: updateError } = await supabase
      .from('transactions')
      .update({ bank_connection_id: toConnectionId })
      .eq('company_id', companyId)
      .in('id', ids)

    if (updateError) {
      log.error('transaction re-point update failed', {
        fromConnectionId,
        toConnectionId,
        error: updateError.message,
      })
      break
    }
    total += ids.length
    if (ids.length < REPOINT_BATCH_SIZE) break
  }

  if (total > 0) {
    log.info('re-pointed transactions onto superseding connection', {
      fromConnectionId,
      toConnectionId,
      count: total,
    })
  }
}
