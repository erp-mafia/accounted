/**
 * bank_connection.sync_failed: one durable event_log row per failed bank
 * sync, whichever path ran it (cron, the manual button, an agent trigger).
 *
 * On 2026-09-03 three connections failed on the same day and nothing but a
 * server log line (expired by the time anyone looked) said why: the failure
 * branches only log.error'ed, and the row's error_message is the same
 * Swedish sentence for every cause (feedback seq 340107). The event carries
 * the failure class, the connection status after handling, the INTERNAL
 * error message and, when the transport exposed them, the HTTP status and
 * the Enable Banking / connector code. Never the user-facing string.
 *
 * One classifier, one emitter: the three sync paths share the taxonomy so
 * the same error is never 'connector' in one row and 'unknown' in another.
 */
import { createLogger } from '@/lib/logger'
import { bankConnectorMode } from '@/lib/connect/instance/upstreams'
import type { CoreEvent } from '@/lib/events/types'
import { AspspUnavailableError, ConnectorSyncError, SessionExpiredError } from './api-client'

const log = createLogger('enable-banking:sync-failed')

export type BankSyncFailureClass = 'session_expired' | 'bank_unavailable' | 'connector' | 'unknown'
export type BankSyncTrigger = 'agent' | 'cron' | 'manual'

export interface BankSyncFailure {
  errorClass: BankSyncFailureClass
  /** Internal error text, capped; never the user-facing Swedish message. */
  message: string
  httpStatus?: number
  ebCode?: string
}

/** Enough to read the cause; a raw Enable Banking envelope can be long. */
const MESSAGE_MAX = 500

function truncate(text: string): string {
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}…` : text
}

/**
 * The error code of an Enable Banking error envelope ({"code": ...} or
 * {"error": "..."}), when the body is one. Anything else yields nothing:
 * the code is a diagnostic bonus, not a contract.
 */
function extractEbCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    const envelope = parsed as { code?: unknown; error?: unknown }
    if (typeof envelope.code === 'string' || typeof envelope.code === 'number') {
      return String(envelope.code).slice(0, 64)
    }
    if (typeof envelope.error === 'string') return envelope.error.slice(0, 64)
    return undefined
  } catch {
    return undefined
  }
}

export function classifyBankSyncFailure(error: unknown): BankSyncFailure {
  if (error instanceof SessionExpiredError) {
    return {
      errorClass: 'session_expired',
      message: truncate(error.message),
      httpStatus: error.status,
      ...(extractEbCode(error.body) ? { ebCode: extractEbCode(error.body) } : {}),
    }
  }
  if (error instanceof AspspUnavailableError) {
    return {
      errorClass: 'bank_unavailable',
      message: truncate(error.message),
      httpStatus: error.status,
      ...(extractEbCode(error.body) ? { ebCode: extractEbCode(error.body) } : {}),
    }
  }
  if (error instanceof ConnectorSyncError) {
    return {
      errorClass: 'connector',
      message: truncate(error.message),
      ...(error.status != null ? { httpStatus: error.status } : {}),
      ebCode: error.code,
    }
  }
  return {
    errorClass: 'unknown',
    message: truncate(error instanceof Error ? error.message : String(error)),
  }
}

export interface EmitBankSyncFailedArgs {
  connectionId: string
  companyId: string
  userId: string
  bankName: string | null
  /** The connection's status AFTER the caller's handling (e.g. 'expired'). */
  status: string
  trigger: BankSyncTrigger
  error: unknown
}

/**
 * Emit the event through the caller's bus (the extension context's emit or
 * eventBus.emit). Never throws: the event is the diagnosis, not the sync,
 * and a bus failure must not change the outcome the caller is about to
 * report.
 */
export async function emitBankSyncFailed(
  emit: (event: CoreEvent) => Promise<void>,
  args: EmitBankSyncFailedArgs,
): Promise<void> {
  const failure = classifyBankSyncFailure(args.error)
  try {
    await emit({
      type: 'bank_connection.sync_failed',
      payload: {
        connectionId: args.connectionId,
        bankName: args.bankName,
        provider: bankConnectorMode(args.companyId) ? 'accounted_connect' : 'enable_banking',
        trigger: args.trigger,
        status: args.status,
        ...failure,
        userId: args.userId,
        companyId: args.companyId,
      },
    })
  } catch (emitError) {
    log.warn('bank_connection.sync_failed could not be emitted', {
      connectionId: args.connectionId,
      trigger: args.trigger,
      message: emitError instanceof Error ? emitError.message : String(emitError),
    })
  }
}
