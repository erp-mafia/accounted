import type { SupabaseClient } from '@supabase/supabase-js'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import type { ExtensionContext } from '@/lib/extensions/types'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { AGIKontrolleraHUSchema, AGIKontrolleraIUSchema } from '@/lib/salary/agi/kontrollera-schemas'
import type {
  AgiUppgift,
  AgiValidateResult,
  SkattekontoSyncPreviewEnvelope,
  SkattekontoSyncResultEnvelope,
  SkvActionFailure,
} from '@/lib/skatteverket/extension-actions'
import { SkatteverketAuthError } from './api-client'
import { agiKontrolleraHU, agiKontrolleraIU } from './agi-client'
import { writeSkatteverketAudit } from './audit'
import { skvAuthCodeToStructured } from './error-map'
import { resolveReadAuth } from './resolve-auth'
import { syncSkattekonto, SKATTEKONTO_LAST_SYNCED_AT_KEY } from './skattekonto-sync'

/**
 * Registry-resolved services behind the AGI pre-validation and the manual
 * skattekonto sync (contract: lib/skatteverket/extension-actions.ts). The v1
 * operations and MCP reach them through extensionRegistry services; the
 * extension's own dashboard routes call them directly. One implementation of
 * the gate (SKATTEVERKET_ENABLED, the paid skatteverket capability), the
 * connection resolution, the SKV call and the regulator audit row.
 *
 * Membership: every caller has already established a non-viewer member of
 * the company (withApiV1 / the MCP door refuse viewers; the dashboard routes
 * run requireAgiWriteRole), which is exactly the AGI write-role set
 * (owner, admin, member), so no second role read happens here.
 */

const DISABLED: SkvActionFailure = {
  ok: false,
  code: 'EXTENSION_DISABLED',
  http_status: 503,
  error: 'Skatteverket-integrationen är inte aktiverad i denna miljö.',
}

const CAPABILITY_BLOCKED: SkvActionFailure = {
  ok: false,
  code: 'SKATTEVERKET_CAPABILITY_BLOCKED',
  http_status: 403,
  error: 'Den här funktionen kräver en betald prenumeration. Uppgradera för att fortsätta använda externa tjänster.',
}

/** Same sentences the extension's read routes answer (readAuthFailureResponse in index.ts). */
const NEEDS_RECONSENT_SV =
  'Anslutningen mot Skatteverket har gått ut. Skatteverkets inloggning gäller bara ca 1 timme, så detta är normalt. Anslut igen med BankID.'
const NOT_CONNECTED_SV = 'Inte ansluten till Skatteverket.'

function enabled(): boolean {
  return process.env.SKATTEVERKET_ENABLED === 'true'
}

async function gate(supabase: SupabaseClient, companyId: string): Promise<SkvActionFailure | null> {
  if (!enabled()) return DISABLED
  if (!(await hasCapability(supabase, companyId, CAPABILITY.skatteverket))) return CAPABILITY_BLOCKED
  return null
}

function authFailure(err: SkatteverketAuthError): SkvActionFailure {
  const mapped = skvAuthCodeToStructured(err.code)
  return {
    ok: false,
    code: mapped.code,
    http_status: mapped.httpStatus,
    error: err.message,
    details: { skv_code: err.code },
  }
}

function statusFailure(status: number, error: string, kod: unknown): SkvActionFailure {
  const code =
    status === 401
      ? 'SKATTEVERKET_NOT_CONNECTED'
      : status === 403
        ? 'SKATTEVERKET_ACCESS_DENIED'
        : status === 429
          ? 'SKATTEVERKET_RATE_LIMITED'
          : 'SKATTEVERKET_API_ERROR'
  const httpStatus = code === 'SKATTEVERKET_API_ERROR' ? 502 : status
  return {
    ok: false,
    code,
    http_status: httpStatus,
    error,
    details: { skv_status: status, ...(typeof kod === 'string' || typeof kod === 'number' ? { skv_kod: kod } : {}) },
  }
}

// ---------------------------------------------------------------------------
// AGI pre-validation (/underlag/huvuduppgift|individuppgift/kontrollera)
// ---------------------------------------------------------------------------

/**
 * Validate one AGI huvuduppgift or individuppgift at Skatteverket without
 * saving anything there. The payload is re-validated against the v1.7 schema
 * here (a direct service call must not forward an unvalidated body), then
 * sent with the caller's own Skatteverket connection; every SKV outcome
 * writes a regulator audit row.
 */
export async function validateAgiUppgift(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  input: { uppgift: AgiUppgift; payload: Record<string, unknown> },
): Promise<AgiValidateResult> {
  const blocked = await gate(supabase, companyId)
  if (blocked) return blocked
  return runValidateAgiUppgift(createExtensionContext(supabase, userId, companyId, 'skatteverket'), input)
}

/**
 * The validation behind the gate. The extension's own routes call this after
 * their requireSkvCapability, behind the dispatcher's SKATTEVERKET_ENABLED
 * gate, so the gate is not read twice.
 */
export async function runValidateAgiUppgift(
  ctx: ExtensionContext,
  input: { uppgift: AgiUppgift; payload: Record<string, unknown> },
): Promise<AgiValidateResult> {
  const { supabase, userId, companyId } = ctx
  const isHu = input.uppgift === 'huvuduppgift'
  const endpoint = isHu ? 'agi.kontrollera.hu' : 'agi.kontrollera.iu'
  const parsed = (isHu ? AGIKontrolleraHUSchema : AGIKontrolleraIUSchema).safeParse(input.payload)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      http_status: 400,
      error: isHu
        ? 'HU-payload matchar inte Skatteverkets v1.7 §7-schema.'
        : 'IU-payload matchar inte Skatteverkets v1.7 §8-schema.',
      details: {
        issues: parsed.error.issues.map((iss) => ({ field: iss.path.join('.'), message: iss.message, code: iss.code })),
      },
    }
  }
  const payload = parsed.data as Record<string, unknown> & { agRegistreradId: string; redovisningsPeriod: string }
  const requestSizeBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  const auditBase = {
    endpoint,
    agRegistreradId: payload.agRegistreradId,
    redovisningsperiod: payload.redovisningsPeriod,
    requestSizeBytes,
  }

  try {
    const result = isHu
      ? await agiKontrolleraHU(supabase, userId, companyId, payload)
      : await agiKontrolleraIU(supabase, userId, companyId, payload)
    if (!result.ok) {
      await writeSkatteverketAudit(ctx, {
        ...auditBase,
        outcome: result.status === 401 || result.status === 403 ? 'auth_error' : 'skv_error',
        responseStatus: result.status,
        errorMessage: result.error,
      })
      return statusFailure(result.status, result.error, result.body?.kod)
    }
    await writeSkatteverketAudit(ctx, {
      ...auditBase,
      outcome: 'ok',
      responseStatus: result.status,
      skvStatus: result.data?.status ?? null,
    })
    return { ok: true, data: { status: result.data.status, fel: result.data.fel ?? [] } }
  } catch (err) {
    await writeSkatteverketAudit(ctx, {
      ...auditBase,
      outcome: 'internal_error',
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    if (err instanceof SkatteverketAuthError) return authFailure(err)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Manual skattekonto sync
// ---------------------------------------------------------------------------

/**
 * Resolve the company's read auth (any member's connection, or a verified
 * lasombud grant), as the extension's read routes do. Reads only.
 */
async function resolveAuth(supabase: SupabaseClient, userId: string, companyId: string) {
  const resolved = await resolveReadAuth(supabase, companyId, { requires: 'lasombud', userId })
  if (resolved.ok) return resolved
  const failure: SkvActionFailure =
    resolved.reason === 'needs_reconsent'
      ? {
          ok: false,
          code: 'SKATTEVERKET_NOT_CONNECTED',
          http_status: 401,
          error: NEEDS_RECONSENT_SV,
          details: { skv_code: 'SESSION_EXPIRED' },
        }
      : {
          ok: false,
          code: 'SKATTEVERKET_NOT_CONNECTED',
          http_status: 401,
          error: NOT_CONNECTED_SV,
          details: { skv_code: 'NOT_CONNECTED' },
        }
  return failure
}

/** Dry run of the sync: gate + connection, read locally. Never calls Skatteverket. */
export async function previewSkattekontoSync(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<SkattekontoSyncPreviewEnvelope> {
  const blocked = await gate(supabase, companyId)
  if (blocked) return blocked
  const resolved = await resolveAuth(supabase, userId, companyId)
  if (!resolved.ok) return resolved
  const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')
  const lastSyncedAt = (await ctx.settings.get<string>(SKATTEKONTO_LAST_SYNCED_AT_KEY)) ?? null
  return { ok: true, data: { auth_source: resolved.source, last_synced_at: lastSyncedAt } }
}

/**
 * Pull fresh saldo + transactions from Skatteverket and upsert them. Any
 * member may trigger it on the company's connection: the resolved auth
 * carries the token OWNER's userId, so a refresh writes back to their row,
 * never the caller's (#1673). Books nothing.
 */
export async function syncSkattekontoNow(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<SkattekontoSyncResultEnvelope> {
  const blocked = await gate(supabase, companyId)
  if (blocked) return blocked
  return runSkattekontoSync(createExtensionContext(supabase, userId, companyId, 'skatteverket'))
}

/** The sync behind the gate, for the extension's own route (already gated upstream). */
export async function runSkattekontoSync(ctx: ExtensionContext): Promise<SkattekontoSyncResultEnvelope> {
  const resolved = await resolveAuth(ctx.supabase, ctx.userId, ctx.companyId)
  if (!resolved.ok) return resolved
  try {
    const result = await syncSkattekonto(ctx, resolved.auth)
    return { ok: true, data: result }
  } catch (err) {
    if (err instanceof SkatteverketAuthError) return authFailure(err)
    throw err
  }
}
