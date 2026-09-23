import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { readBankConfiguration } from '@/lib/cash-accounts/configuration'
import { eventBus } from '@/lib/events/bus'
import { revokeUnusedSession } from './session-revocation'
import type { StoredAccount } from '../types'

const log = createLogger('enable-banking/supersede')

export interface SupersedeInput {
  companyId: string
  userId: string
  newConnectionId: string
  bankName: string | null
  newSessionId: string | null
  newAccounts: readonly StoredAccount[]
  /** Scopes explicitly pinned before this callback must outrank donor scopes. */
  preserveDedupScopeUids?: string[]
}

export interface SupersedeResult {
  supersededIds: string[]
  /** Current committed metadata, including any carried legacy dedup scope. */
  accounts: StoredAccount[]
}

/** Park siblings, repoint feed metadata, release claims and carry sync state
 * through one checked transaction. Provider HTTP starts after commit and
 * requires the cross-company revocation claim. */
export async function supersedeSiblingConnections(
  supabase: SupabaseClient, input: SupersedeInput,
): Promise<SupersedeResult> {
  const snapshot = await readBankConfiguration(supabase, input.companyId, input.newConnectionId)
  const { data, error } = await supabase.rpc('supersede_bank_connections', {
    p_company_id: input.companyId, p_user_id: input.userId, p_connection_id: input.newConnectionId,
    p_expected_token: snapshot.token, p_expected_session_id: input.newSessionId,
    p_preserve_scope_uids: input.preserveDedupScopeUids ?? [],
  })
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  if (!Array.isArray(data?.superseded) || !Array.isArray(data?.accounts)
    || data.superseded.some((row: { id?: unknown; session_id?: unknown }) => typeof row?.id !== 'string'
      || (row.session_id !== null && typeof row.session_id !== 'string'))) {
    throw new Error('Bank supersession receipt missing')
  }
  const superseded = data.superseded as Array<{ id: string; session_id: string | null }>
  await finishBankSupersession(supabase, { ...input, bankName: snapshot.connection.bank_name }, superseded)
  return { supersededIds: superseded.map(row => row.id), accounts: data.accounts }
}

/** External effects belong after the caller's entire transaction commits. */
export async function finishBankSupersession(
  supabase: SupabaseClient,
  input: Pick<SupersedeInput, 'companyId' | 'userId' | 'newConnectionId' | 'bankName' | 'newSessionId'>,
  superseded: Array<{ id: string; session_id: string | null }>,
): Promise<void> {
  const sessions = new Set(superseded.flatMap(row => row.session_id && row.session_id !== input.newSessionId ? [row.session_id] : []))
  for (const sessionId of sessions) {
    try {
      await revokeUnusedSession(supabase, sessionId)
    } catch {
      log.warn('upstream consent cleanup was not confirmed after supersession', {
        newConnectionId: input.newConnectionId,
      })
    }
  }
  for (const sibling of superseded) {
    try {
      await eventBus.emit({ type: 'bank_connection.superseded', payload: {
        connectionId: sibling.id, supersededById: input.newConnectionId, bankName: input.bankName,
        userId: input.userId, companyId: input.companyId,
      } })
    } catch (error) {
      log.error('failed to emit bank_connection.superseded', error as Error, { siblingId: sibling.id })
    }
  }
}
