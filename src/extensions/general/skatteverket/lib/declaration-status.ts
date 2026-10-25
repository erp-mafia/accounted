import type { SupabaseClient } from '@supabase/supabase-js'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import type {
  SkvVatDeclarationStatusInput,
  SkvVatDeclarationStatusResult,
} from '@/lib/skatteverket/declaration-status'
import { skvRequestWithAuth, SkatteverketAuthError } from './api-client'
import { resolveReadAuth } from './resolve-auth'
import { resolveRedovisare, resolveRedovisningsperiod } from './declaration-prep'
import { skvAuthCodeToStructured } from './error-map'
import { isSkatteverketEnabled } from '@/lib/skatteverket/enabled'

/**
 * Registry-resolved read service for filed momsdeklarationer (issue #1663).
 *
 * Fetches Skatteverket's /inlamnat (the declaration as submitted) and/or
 * /beslutat (the beslut) views for one period, so API consumers (v1 REST) can
 * compare their books against actually-filed data. Read-only on SKV's side;
 * the only local writes are the regulator audit rows.
 *
 * Auth follows the company-scoped read model (#1673, resolve-auth.ts): the
 * caller's own token when they connected, otherwise any other member's active
 * token, otherwise system credentials with a verified ombud grant. The fetched
 * declaration belongs to the company, not to whoever pressed "Anslut". The
 * audit rows (one per view, written by the transport) name the caller.
 *
 * Error contract: known failure modes return `{ ok: false, code, http_status,
 * error }` with structured codes so the v1 route maps them deterministically;
 * unexpected errors are thrown and handled by the route wrapper.
 */
export async function fetchVatDeclarationStatus(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  input: SkvVatDeclarationStatusInput,
): Promise<SkvVatDeclarationStatusResult> {
  // Direct service calls bypass the HTTP dispatcher's SKATTEVERKET_ENABLED
  // gate (app/api/extensions/ext/[...path]/route.ts), so check the flag here:
  // same reasoning as the commit services in index.ts.
  if (!isSkatteverketEnabled()) {
    return {
      ok: false,
      code: 'EXTENSION_DISABLED',
      http_status: 503,
      error: 'Skatteverket-integrationen är inte aktiverad i denna miljö.',
    }
  }

  const state = input.state ?? 'both'
  const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')

  let redovisare: string
  try {
    redovisare = await resolveRedovisare(supabase, companyId)
  } catch (err) {
    // Missing org number in company settings: a configuration problem the
    // caller can fix, not a server error.
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      http_status: 400,
      error:
        err instanceof Error ? err.message : 'Organisationsnummer saknas i företagsinställningar',
    }
  }

  try {
    // Same räkenskapsår-aware resolution as buildMomsuppgift, so the period
    // identifier matches what was filed (helårsmoms: FY-end month).
    const redovisningsperiod = await resolveRedovisningsperiod(supabase, companyId, {
      periodType: input.periodType, year: input.year, period: input.period,
    })

    const resolved = await resolveReadAuth(supabase, companyId, {
      requires: 'moms_ombud',
      userId,
    })
    if (!resolved.ok) {
      return {
        ok: false,
        code: 'SKATTEVERKET_NOT_CONNECTED',
        http_status: 401,
        error:
          resolved.reason === 'needs_reconsent'
            ? 'Anslutningen mot Skatteverket behöver förnyas: Skatteverkets personliga inloggning räcker i ungefär tio timmar, så detta är normalt. Be användaren ansluta igen med BankID under Inställningar → Skatteverket. Bara en person kan göra det; försök inte igen förrän användaren bekräftat.'
            : 'Inte ansluten till Skatteverket. Be användaren ansluta med BankID under Inställningar → Skatteverket.',
      }
    }

    const fetchView = (view: 'inlamnat' | 'beslutat') =>
      fetchDeclarationView(resolved.auth, { view, companyId, userId, redovisare, redovisningsperiod }, ctx.log)

    let submitted: unknown = null
    let decided: unknown = null
    if (state === 'submitted' || state === 'both') {
      const result = await fetchView('inlamnat')
      if (!result.ok) return result.failure
      submitted = result.body
    }
    if (state === 'decided' || state === 'both') {
      const result = await fetchView('beslutat')
      if (!result.ok) return result.failure
      decided = result.body
    }

    return { ok: true, redovisare, redovisningsperiod, submitted, decided }
  } catch (err) {
    if (err instanceof SkatteverketAuthError) {
      const mapped = skvAuthCodeToStructured(err.code)
      return { ok: false, code: mapped.code, http_status: mapped.httpStatus, error: err.message }
    }
    throw err
  }
}

export type DeclarationViewFetch =
  | { ok: true; body: unknown }
  | { ok: false; failure: Extract<SkvVatDeclarationStatusResult, { ok: false }> }

/**
 * One filed-declaration view from Skatteverket: /inlamnat (as filed) or
 * /beslutat (the beslut), for the v1 read service above and the dashboard's
 * /declaration/submitted and /declaration/decided routes alike.
 *
 * 404 means "nothing on file for the period": a normal answer (body null),
 * not an upstream failure. A 2xx with an unreadable body is recorded as
 * skv_error (expectJson) and fails as SKATTEVERKET_API_ERROR. The upstream
 * body is logged server-side only: forwarding it would leak Skatteverket
 * system details, so the caller gets the status and a generic sentence.
 */
export async function fetchDeclarationView(
  auth: Parameters<typeof skvRequestWithAuth>[0],
  args: {
    view: 'inlamnat' | 'beslutat'
    companyId: string
    userId: string
    redovisare: string
    redovisningsperiod: string
  },
  log: { warn: (message: string, ...rest: unknown[]) => void },
): Promise<DeclarationViewFetch> {
  const { view, companyId, userId, redovisare, redovisningsperiod } = args
  const res = await skvRequestWithAuth(auth, 'GET', `/${view}/${redovisare}/${redovisningsperiod}`, {
    endpoint: view,
    companyId,
    userId,
    agRegistreradId: redovisare,
    redovisningsperiod,
    okStatuses: [404],
    expectJson: true,
  })
  let body: unknown = null
  let bodyUnparseable = false
  if (res.ok) {
    try {
      body = await res.json()
    } catch {
      bodyUnparseable = true
    }
  }
  if (res.status === 404) return { ok: true, body: null }
  if (!res.ok || bodyUnparseable) {
    const text = bodyUnparseable ? '<2xx body was not valid JSON>' : await res.text().catch(() => '')
    log.warn('skv declaration-status upstream error', { view, status: res.status, body: text.slice(0, 500) })
    return {
      ok: false,
      failure: {
        ok: false,
        code: 'SKATTEVERKET_API_ERROR',
        http_status: 502,
        error: bodyUnparseable
          ? 'Skatteverket svarade med ett svar som inte kunde tolkas.'
          : `Skatteverket svarade med ${res.status}.`,
      },
    }
  }
  return { ok: true, body }
}
