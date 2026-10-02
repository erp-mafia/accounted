import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { disconnectBankConnection, readBankConfiguration } from '@/lib/cash-accounts/configuration'
import type { CoreEvent } from '@/lib/events/types'
import type { ExtensionLogger } from '@/lib/extensions/types'
import { revokeUnusedSession } from './session-revocation'

export interface RetireBankConnectionInput {
  supabase: SupabaseClient
  companyId: string
  userId: string
  connectionId: string
  log: Pick<ExtensionLogger, 'warn' | 'error'>
  /** The route's emitter; the process-wide event bus when omitted. */
  emit?: (event: CoreEvent) => Promise<void>
}

/**
 * Remove one bank connection the way "Ta bort anslutningen" does. One path
 * for every caller: the disconnect route, and a fresh connect that meets a
 * connection with nothing left to pick.
 *
 * The local disconnect commits first, in one checked RPC; a refusal there
 * throws for the caller to answer. The upstream consent cleanup and the
 * audit event follow the commit and are best effort: the local disconnect
 * already stands, and the revocation claim fences a later attachment.
 */
export async function retireBankConnection(input: RetireBankConnectionInput): Promise<void> {
  const { supabase, companyId, userId, connectionId, log } = input
  const snapshot = await readBankConfiguration(supabase, companyId, connectionId)
  const connection = await disconnectBankConnection(supabase, companyId, userId, connectionId, snapshot.token)

  // Both local writes have committed. The service-only claim checks all
  // companies and prevents a new holder attaching before provider HTTP.
  if (connection.session_id) {
    try {
      await revokeUnusedSession(await createServiceClient(), connection.session_id)
    } catch {
      // Local disconnect remains committed if upstream cleanup fails.
      // The claim records provider failure and fences later attachment.
      log.warn('[enable-banking] Upstream consent cleanup was not confirmed', {
        connectionId, userId, companyId,
      })
    }
  }

  try {
    const emit = input.emit ?? await defaultEmit()
    await emit({
      type: 'bank_connection.revoked',
      payload: {
        connectionId: connection.connection_id,
        bankName: connection.bank_name,
        userId,
        companyId,
      },
    })
  } catch (emitError) {
    log.error('[enable-banking] Failed to emit revoke event', {
      errorMessage: emitError instanceof Error ? emitError.message : String(emitError),
      connectionId: connection.connection_id,
      userId,
      companyId,
    })
  }
}

async function defaultEmit(): Promise<(event: CoreEvent) => Promise<void>> {
  const { eventBus } = await import('@/lib/events/bus')
  return eventBus.emit.bind(eventBus)
}
