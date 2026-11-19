import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { eventBus } from '@/lib/events/bus'
import { revokeUnusedSession } from './session-revocation'

const log = createLogger('enable-banking/supersede')

export interface FinishSupersessionInput {
  companyId: string
  userId: string
  newConnectionId: string
  bankName: string | null
  newSessionId: string | null
}

/** External effects belong after the caller's entire transaction commits. */
export async function finishBankSupersession(
  supabase: SupabaseClient,
  input: FinishSupersessionInput,
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
