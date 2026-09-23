/**
 * GET /agi/kvittenser: the check the AGI panel runs when the user comes back
 * from signing at Skatteverket (on entering awaiting_signing, on tab focus, on
 * the timers, and behind the "Hämta kvittens" button).
 *
 * Two things are pinned here:
 *   1. Skatteverket's gateway refusing the APIGW client (#973, #2226) answers
 *      with a code the panel can act on and a message written for the person
 *      filing, not the operator guidance about an env var and Utvecklarportalen.
 *   2. A kvittens observed here goes through the SAME promotion as the cron
 *      and the post-connect refresh, so the filing side effects run exactly
 *      once whichever path sees the receipt first.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/agi-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, agiGetKvittenser: vi.fn() }
})

vi.mock('../lib/agi-kvittens-reconcile', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, promoteAgiDeclaration: vi.fn() }
})

import { skatteverketExtension } from '../index'
import { agiGetKvittenser } from '../lib/agi-client'
import { promoteAgiDeclaration } from '../lib/agi-kvittens-reconcile'
import { SkatteverketAuthError } from '../lib/api-client'
import type { ExtensionContext } from '@/lib/extensions/types'

const mockAgiGetKvittenser = vi.mocked(agiGetKvittenser)
const mockPromote = vi.mocked(promoteAgiDeclaration)

function findRoute() {
  const route = skatteverketExtension.apiRoutes?.find(
    (r) => r.method === 'GET' && r.path === '/agi/kvittenser',
  )
  if (!route) throw new Error('kvittenser route not registered')
  return route
}

/** Supabase stub: records updates per table; the declaration lookup resolves to `latest`. */
function makeContext(latest: Record<string, unknown> | null) {
  const updates: Array<{ table: string; values: unknown }> = []
  const supabase = {
    from: vi.fn((table: string) => {
      const chain: any = {}
      for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
        chain[method] = vi.fn(() => chain)
      }
      chain.update = vi.fn((values: unknown) => {
        updates.push({ table, values })
        return chain
      })
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: table === 'agi_declarations' ? latest : null,
        error: null,
      })
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    }),
  }
  const settingsSet = vi.fn().mockResolvedValue(undefined)
  const ctx = {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    requestId: 'req_test',
    supabase,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    settings: { get: vi.fn().mockResolvedValue(null), set: settingsSet, clear: vi.fn() },
  } as unknown as ExtensionContext
  return { ctx, updates, settingsSet }
}

const request = (qs = '?arbetsgivare=165561234567&period=202609') =>
  new Request(`http://localhost/api/extensions/ext/skatteverket/agi/kvittenser${qs}`)

const KVITTENS = {
  arbetsgivare: '165561234567',
  period: '202609',
  uuidKvittens: 'uuid-1',
  signeradAv: '191212121212',
  signeradTid: '2026-09-21T08:05:00Z',
  underlag: { arbetsgivarregistrerad: '165561234567', redovisningsperiod: '202609', antalIu: 2, antalIuTillagda: 0, antalIuBorttagna: 0 },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('GET /agi/kvittenser', () => {
  it('400 without arbetsgivare and period', async () => {
    const { ctx } = makeContext(null)
    const res = await findRoute().handler(request(''), ctx)
    expect(res.status).toBe(400)
    expect(mockAgiGetKvittenser).not.toHaveBeenCalled()
  })

  it('answers the gateway refusal with KVITTENS_UNAVAILABLE and a message for the person filing', async () => {
    mockAgiGetKvittenser.mockRejectedValueOnce(
      new SkatteverketAuthError(
        'Skatteverkets API-gateway nekade anropet till "arbetsgivardeklaration/hanteraredovisningsperiod/v1". ' +
          'Kontrollera att din APIGW-klient (SKATTEVERKET_APIGW_CLIENT_ID) har prenumeration på denna tjänst i Utvecklarportalen.',
        'ACCESS_DENIED',
        'APIGW_CLIENT_REFUSED',
      ),
    )
    const { ctx, updates, settingsSet } = makeContext({ id: 'decl-1', salary_run_id: 'run-1', status: 'pending_signature' })

    const res = await findRoute().handler(request(), ctx)
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('KVITTENS_UNAVAILABLE')
    // Where the receipt can be verified, not how to fix an API subscription.
    expect(body.error).toContain('e-tjänst Arbetsgivardeklaration')
    expect(body.error).not.toMatch(/APIGW|SKATTEVERKET_|Utvecklarportalen/)
    // Nothing is asserted about the filing: no status change, no cache write.
    expect(updates).toEqual([])
    expect(settingsSet).not.toHaveBeenCalled()
    expect(mockPromote).not.toHaveBeenCalled()
  })

  it('leaves every other auth error on the existing mapping', async () => {
    mockAgiGetKvittenser.mockRejectedValueOnce(
      new SkatteverketAuthError('Sessionen har gått ut. Logga in med BankID igen.', 'SESSION_EXPIRED'),
    )
    const { ctx } = makeContext(null)

    const res = await findRoute().handler(request(), ctx)

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'SESSION_EXPIRED' })
  })

  it('changes nothing while the period has no kvittens', async () => {
    mockAgiGetKvittenser.mockResolvedValueOnce({ ok: true, status: 200, data: { kvittenser: [] } } as any)
    const { ctx, updates, settingsSet } = makeContext({ id: 'decl-1', salary_run_id: 'run-1', status: 'pending_signature' })

    const res = await findRoute().handler(request(), ctx)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { kvittenser: [] } })
    expect(mockPromote).not.toHaveBeenCalled()
    expect(updates).toEqual([])
    expect(settingsSet).not.toHaveBeenCalled()
  })

  it('promotes a declaration awaiting signature through the shared claim, not an inline update', async () => {
    mockAgiGetKvittenser.mockResolvedValueOnce({ ok: true, status: 200, data: { kvittenser: [KVITTENS] } } as any)
    mockPromote.mockResolvedValueOnce({ status: 'signed', kvittensnummer: 'uuid-1' })
    const { ctx, updates, settingsSet } = makeContext({ id: 'decl-1', salary_run_id: 'run-1', status: 'pending_signature' })

    const res = await findRoute().handler(request(), ctx)

    expect(res.status).toBe(200)
    expect(mockPromote).toHaveBeenCalledTimes(1)
    expect(mockPromote).toHaveBeenCalledWith(
      ctx.supabase,
      { id: 'decl-1', company_id: 'company-1', salary_run_id: 'run-1', period_year: 2026, period_month: 9 },
      KVITTENS,
      {
        reconciledBy: 'interactive',
        submittedBy: 'user-1',
        // The user is looking at the panel: it shows the receipt itself.
        notifyUserId: null,
        fromStatuses: ['pending_signature', 'generated', 'exported'],
      },
    )
    // The promotion owns every write: the route neither updates the row nor
    // re-creates the in-flight cache the promotion deletes.
    expect(updates).toEqual([])
    expect(settingsSet).not.toHaveBeenCalled()
  })

  it('still answers 200 when the cron won the claim a moment earlier', async () => {
    mockAgiGetKvittenser.mockResolvedValueOnce({ ok: true, status: 200, data: { kvittenser: [KVITTENS] } } as any)
    mockPromote.mockResolvedValueOnce({ status: 'already_claimed' })
    const { ctx, updates } = makeContext({ id: 'decl-1', salary_run_id: 'run-1', status: 'pending_signature' })

    const res = await findRoute().handler(request(), ctx)

    expect(res.status).toBe(200)
    expect((await res.json()).data.kvittenser[0].uuidKvittens).toBe('uuid-1')
    expect(updates).toEqual([])
  })

  it('keeps the previous behaviour for a period that already carries a receipt (a correction)', async () => {
    mockAgiGetKvittenser.mockResolvedValueOnce({ ok: true, status: 200, data: { kvittenser: [KVITTENS] } } as any)
    const { ctx, updates, settingsSet } = makeContext({ id: 'decl-1', salary_run_id: 'run-2', status: 'submitted' })

    const res = await findRoute().handler(request(), ctx)

    expect(res.status).toBe(200)
    expect(mockPromote).not.toHaveBeenCalled()
    expect(settingsSet).toHaveBeenCalledTimes(1)
    expect(updates.map(u => u.table)).toEqual(['agi_declarations', 'salary_runs'])
    expect(updates[0].values).toMatchObject({ status: 'submitted', kvittensnummer: 'uuid-1' })
  })
})
