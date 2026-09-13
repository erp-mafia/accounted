/**
 * bank_connection.sync_failed: one durable event_log row per failed bank
 * sync, whichever path ran it (cron, the manual button, an agent trigger).
 *
 * On 2026-09-03 three connections failed on the same day and nothing but a
 * server log line (expired by the time anyone looked) said why: the failure
 * branches only log.error'ed, and the row's error_message is the same
 * Swedish sentence for every cause (feedback seq 340107). The event carries
 * the failure class, the connection status after handling, a REDACTED
 * diagnostic and, when the transport exposed them, the HTTP status and the
 * Enable Banking / connector code. Never the user-facing string, and never a
 * raw provider body: event_log is an audit surface, and an upstream error
 * message can quote response data (account identifiers, names). The full
 * message still goes to the server log at the call site.
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
  /**
   * Structured, redacted summary: the error class name plus a scrubbed,
   * capped phrase. For the typed transport errors it is a fixed template
   * (status and our own reason/code, never the body); for anything else the
   * message is scrubbed of JSON, tags, URLs, e-mail addresses and digit runs
   * before it is capped. Never the user-facing Swedish message.
   */
  diagnostic: string
  httpStatus?: number
  ebCode?: string
}

/** Enough to tell failures apart in a list; never a place for a body. */
const DIAGNOSTIC_MAX = 160
/** Enable Banking error codes are short upper-case tokens; anything else is body text. */
const EB_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/

/**
 * Scrub free-text error messages before they reach event_log. The patterns
 * are deliberately broad: a JSON object, a URL, an e-mail address or a run
 * of four or more digits (account numbers, personnummer, request ids) is
 * never needed to diagnose a sync failure. Angle brackets are dropped as
 * single characters (no tag parsing: this is a log field, not HTML output,
 * and a tag-shaped regex is what CodeQL rightly refuses as a sanitizer).
 */
export function redactDiagnostic(text: string): string {
  return text
    .replace(/\{[\s\S]*\}/g, '{…}')
    .replace(/\[[\s\S]*\]/g, '[…]')
    .replace(/[<>]/g, ' ')
    .replace(/https?:\/\/\S+/gi, '(url)')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '(email)')
    .replace(/\d{4,}/g, '(digits)')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DIAGNOSTIC_MAX)
}

/**
 * The error code of an Enable Banking error envelope ({"code": ...} or
 * {"error": "..."}), when the body is one and the value looks like a code.
 * Body text that happens to sit in the `error` field is dropped: the code is
 * a diagnostic bonus, not a channel for the body.
 */
function extractEbCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    const envelope = parsed as { code?: unknown; error?: unknown }
    if (typeof envelope.code === 'number') return String(envelope.code)
    const candidate =
      typeof envelope.code === 'string' ? envelope.code
      : typeof envelope.error === 'string' ? envelope.error
      : undefined
    return candidate !== undefined && EB_CODE_RE.test(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

export function classifyBankSyncFailure(error: unknown): BankSyncFailure {
  if (error instanceof SessionExpiredError) {
    const ebCode = extractEbCode(error.body)
    return {
      errorClass: 'session_expired',
      diagnostic: `SessionExpiredError: bank session expired (HTTP ${error.status})`,
      httpStatus: error.status,
      ...(ebCode ? { ebCode } : {}),
    }
  }
  if (error instanceof AspspUnavailableError) {
    const ebCode = extractEbCode(error.body)
    return {
      errorClass: 'bank_unavailable',
      diagnostic: `AspspUnavailableError: bank unavailable (HTTP ${error.status}, ${redactDiagnostic(String(error.reason))})`,
      httpStatus: error.status,
      ...(ebCode ? { ebCode } : {}),
    }
  }
  if (error instanceof ConnectorSyncError) {
    return {
      errorClass: 'connector',
      diagnostic: `ConnectorSyncError: ${redactDiagnostic(String(error.code))}`,
      ...(error.status != null ? { httpStatus: error.status } : {}),
      ebCode: error.code,
    }
  }
  const name = error instanceof Error ? error.name : 'Error'
  const message = error instanceof Error ? error.message : String(error)
  return {
    errorClass: 'unknown',
    diagnostic: redactDiagnostic(`${name}: ${message}`),
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
