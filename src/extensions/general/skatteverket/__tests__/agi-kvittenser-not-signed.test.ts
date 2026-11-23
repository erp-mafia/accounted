/**
 * GET .../redovisningsperioder/{period}/kvittenser while the AGI is not signed
 * yet: Skatteverket answers 404 {"message": "Resource not found"}, not 200 with
 * an empty list. Production, 30 days to 2026-11-22: 592 such answers for 58
 * companies; in each of the 55 periods that later got a receipt every 404 came
 * before the first 200 and none after, and the 6 periods with only 404s were
 * unsigned, rejected or never sent. Read as a failed read, it was counted as
 * an error by the kvittens cron every 15 minutes (raised at error level every
 * six hours) and shown as "Kunde inte hämta kvittens" behind "Hämta kvittens".
 *
 * It is nothing on file for the period, as /inlamnat and /beslutat read their
 * 404 (declaration-status.ts): an empty list, and the audit row says 'ok'.
 * Only fetch, the token store and the audit insert are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auditMock = vi.hoisted(() => vi.fn())

vi.mock('../lib/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/audit')>()
  return { ...actual, writeSkatteverketAudit: (...a: unknown[]) => auditMock(...a) }
})

vi.mock('../lib/token-store', () => ({
  getTokens: vi.fn(async () => ({
    access_token: 'user-bearer',
    refresh_token: 'user-refresh',
    expires_at: Date.now() + 60 * 60_000,
    refresh_count: 0,
    scope: 'agd agdredovisningperiod',
  })),
  storeTokens: vi.fn(),
  deleteTokens: vi.fn(),
}))

vi.mock('../lib/system-auth/token-provider', () => ({
  getSystemAccessToken: vi.fn(async () => 'system-bearer'),
  invalidateSystemToken: vi.fn(),
}))

import { agiGetKvittenser } from '../lib/agi-client'
import type { SkvAuth } from '../lib/api-client'

const employer = '165561234567'
const userAuth: SkvAuth = {
  mode: 'user',
  supabase: {} as Extract<SkvAuth, { mode: 'user' }>['supabase'],
  userId: 'user-1',
  companyId: 'company-1',
}
const actor = { companyId: 'company-1', userId: 'user-1' }

function answer(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })))
}

beforeEach(() => {
  auditMock.mockReset()
  vi.stubEnv('SKATTEVERKET_DISABLED', '')
  vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_ID', 'gateway-id')
  vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_SECRET', 'gateway-secret')
  vi.stubEnv('SKATTEVERKET_OAUTH2_CLIENT_ID', '')
  vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
  vi.stubEnv('CONNECT_SKV_CANARY_COMPANIES', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('agiGetKvittenser before the AGI is signed', () => {
  it("reads Skatteverket's 404 as no kvittens yet, and audits it as a normal answer", async () => {
    answer(404, { message: 'Resource not found' })

    const result = await agiGetKvittenser(userAuth, employer, '202611', actor)

    expect(result).toEqual({ ok: true, status: 404, data: { kvittenser: [] } })
    expect(auditMock).toHaveBeenCalledTimes(1)
    expect(auditMock.mock.calls[0][1]).toMatchObject({ endpoint: 'kvittenser', outcome: 'ok', responseStatus: 404 })
  })

  it('returns the receipts once there are some', async () => {
    const kvittenser = [{ arbetsgivare: employer, period: '202611', uuidKvittens: 'k-1', signeradTid: '2026-11-22T14:00:00Z' }]
    answer(200, { kvittenser })

    const result = await agiGetKvittenser(userAuth, employer, '202611', actor)

    expect(result).toEqual({ ok: true, status: 200, data: { kvittenser } })
  })

  it("still refuses with Skatteverket's own message for any other answer", async () => {
    answer(400, { kod: 12, meddelandeTillAnvandare: 'Redovisningsperioden är felaktig.' })

    const result = await agiGetKvittenser(userAuth, employer, '202611', actor)

    expect(result).toMatchObject({ ok: false, status: 400, error: 'Redovisningsperioden är felaktig.' })
    expect(auditMock.mock.calls[0][1]).toMatchObject({ outcome: 'skv_error', responseStatus: 400 })
  })
})
