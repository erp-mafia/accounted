/**
 * Core <-> Skatteverket-extension boundary for two helper actions that talk
 * to Skatteverket: AGI pre-validation (/kontrollera, read-only on SKV's side)
 * and the manual skattekonto sync.
 *
 * `lib/` and `app/api/v1/` cannot import from `@/extensions/` (CI guard), so
 * the operations (lib/operations/skatteverket.ts) reach the extension only
 * through the registry-resolved `services` channel, the same seam the
 * pending-operations commit path (./../pending-operations/skatteverket-commit.ts)
 * and the filed-declaration read (./declaration-status.ts) use. This module
 * holds the SHARED shapes, so the extension (which may import core freely)
 * and core agree without core importing the extension, plus the mapping from
 * a service result to an OperationOutcome.
 *
 * The extension's dashboard routes (/agi/kontrollera/hu, /agi/kontrollera/iu,
 * /skattekonto/sync) call the same service functions, so the capability gate,
 * the connection resolution, the SKV call and the regulator audit row are one
 * implementation. The extension is opt-in: when it is not registered, or
 * SKATTEVERKET_ENABLED is off, every door answers EXTENSION_DISABLED.
 *
 * External-call rule: a dry run never reaches Skatteverket. The sync's dry
 * run only reads the local connection state; the AGI validation is a read
 * (SKV saves nothing) and has no dry run.
 */
import { extensionRegistry } from '@/lib/extensions/registry'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'

export type AgiUppgift = 'huvuduppgift' | 'individuppgift'

/** Skatteverket's kontrollsvar severity (AGI API v1.7). */
export type AgiKontrollStatus = 'OK' | 'INFO' | 'ARENDE' | 'STOPP' | 'AVVISANDE'

export interface AgiKontrollsvar {
  status: AgiKontrollStatus
  fel: Array<{ status: AgiKontrollStatus; felmeddelande?: string }>
}

/**
 * A service failure. details.skv_code carries Skatteverket's own auth code
 * (NOT_CONNECTED, SESSION_EXPIRED, ...) when the connection is the cause, so
 * the extension's dashboard routes keep answering the envelope their UI reads.
 */
export interface SkvActionFailure {
  ok: false
  /** Structured error code (lib/errors/structured-errors.ts). */
  code: string
  http_status: number
  /** Swedish sentence naming the cause. */
  error: string
  /** Extra machine-readable context (e.g. Skatteverket's own status and felkod). */
  details?: Record<string, unknown>
}

export type AgiValidateResult = { ok: true; data: AgiKontrollsvar } | SkvActionFailure

export interface SkattekontoSyncSummary {
  /** New or status-promoted booked rows. */
  booked: number
  /** New or updated upcoming rows. */
  upcoming: number
  /** Rows dropped because Skatteverket omitted a required field. */
  skipped: number
  saldoSkatteverket: number
  saldoKronofogden: number
  syncedAt: string
}

export type SkattekontoSyncResultEnvelope = { ok: true; data: SkattekontoSyncSummary } | SkvActionFailure

export interface SkattekontoSyncPreview {
  /** Where the read would authenticate: the company's ombud grant or a member's BankID connection. */
  auth_source: 'system' | 'user'
  last_synced_at: string | null
}

export type SkattekontoSyncPreviewEnvelope = { ok: true; data: SkattekontoSyncPreview } | SkvActionFailure

/** What a fully wired skatteverket extension exposes on `services` for these actions. */
export interface SkatteverketActionServices {
  validateAgiUppgift: (
    supabase: unknown,
    userId: string,
    companyId: string,
    input: { uppgift: AgiUppgift; payload: Record<string, unknown> },
  ) => Promise<AgiValidateResult>
  syncSkattekontoNow: (supabase: unknown, userId: string, companyId: string) => Promise<SkattekontoSyncResultEnvelope>
  previewSkattekontoSync: (
    supabase: unknown,
    userId: string,
    companyId: string,
  ) => Promise<SkattekontoSyncPreviewEnvelope>
}

type Failure = Extract<OperationOutcome<never>, { ok: false }>

const DISABLED: Failure = { ok: false, code: 'EXTENSION_DISABLED' }

function services<K extends keyof SkatteverketActionServices>(key: K): SkatteverketActionServices[K] | null {
  const wired = extensionRegistry.get('skatteverket')?.services as Partial<SkatteverketActionServices> | undefined
  return wired?.[key] ?? null
}

function toFailure(result: SkvActionFailure): Failure {
  return {
    ok: false,
    code: result.code,
    messageSv: result.error,
    ...(result.details ? { details: result.details } : {}),
  }
}

/**
 * Pre-validate one AGI huvuduppgift or individuppgift at Skatteverket
 * (/underlag/.../kontrollera). Saves nothing at Skatteverket; the only local
 * write is the regulator audit row.
 */
export async function validateAgiAtSkatteverket(
  ctx: OperationContext,
  uppgift: AgiUppgift,
  payload: Record<string, unknown>,
): Promise<OperationOutcome<AgiKontrollsvar>> {
  const validate = services('validateAgiUppgift')
  if (!validate) return DISABLED
  const result = await validate(ctx.supabase, ctx.userId, ctx.companyId, { uppgift, payload })
  if (!result.ok) return toFailure(result)
  return { ok: true, data: result.data }
}

/**
 * Fetch the skattekonto (saldo and transactions) from Skatteverket now and
 * store it, instead of waiting for the hourly cron. Books nothing. The dry
 * run checks the gate and the connection locally and never calls SKV.
 */
export async function syncSkattekontoFromSkatteverket(
  ctx: OperationContext,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<SkattekontoSyncSummary>> {
  if (options.dryRun) {
    const preview = services('previewSkattekontoSync')
    if (!preview) return DISABLED
    const result = await preview(ctx.supabase, ctx.userId, ctx.companyId)
    if (!result.ok) return toFailure(result)
    return {
      ok: true,
      dryRun: true,
      preview: {
        ...result.data,
        will: 'fetch the skattekonto saldo and transactions from Skatteverket and store them; nothing is booked',
      },
    }
  }
  const sync = services('syncSkattekontoNow')
  if (!sync) return DISABLED
  const result = await sync(ctx.supabase, ctx.userId, ctx.companyId)
  if (!result.ok) return toFailure(result)
  return { ok: true, data: result.data }
}
