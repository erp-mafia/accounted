/**
 * GET /declaration/signing: the Moms page's "Väntar på signering" reads the
 * period's stored lock state, so a declaration locked by an approval in
 * /pending (or before a reload) still shows its BankID link (crm#1478).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { testRoutes } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import { skatteverketExtension } from '../index'
import { awaitingSignatureOf } from '../lib/submission-state'

const SIGNING_URL = 'https://www7.skatteverket.se/portal/skriv-under'

const settingsGet = vi.fn()
const ctx = {
  userId: 'user-1',
  companyId: 'company-1',
  supabase: {},
  settings: { get: settingsGet, set: vi.fn(), clear: vi.fn() },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as ExtensionContext

function route() {
  const found = testRoutes(skatteverketExtension).find((r) => r.method === 'GET' && r.path === '/declaration/signing')
  if (!found) throw new Error('/declaration/signing not registered')
  return found
}

const request = (period: string) =>
  new Request(`http://localhost/api/extensions/ext/skatteverket/declaration/signing?redovisningsperiod=${period}`)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /declaration/signing', () => {
  it('answers the signing link while the period is locked for signing', async () => {
    settingsGet.mockResolvedValue(
      JSON.stringify({
        status: 'draft_locked',
        redovisningsperiod: '202608',
        signeringsLank: SIGNING_URL,
        updatedAt: '2026-10-26T13:43:59.000Z',
      }),
    )

    const res = await route().handler(request('202608'), ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      data: { signeringsLank: SIGNING_URL, updatedAt: '2026-10-26T13:43:59.000Z' },
    })
    expect(settingsGet).toHaveBeenCalledWith('submission_202608')
  })

  it('answers data null once the period is signed, or when nothing is stored', async () => {
    settingsGet.mockResolvedValueOnce(JSON.stringify({ status: 'signed', signeringsLank: SIGNING_URL }))
    await expect((await route().handler(request('202608'), ctx)).json()).resolves.toEqual({ data: null })

    settingsGet.mockResolvedValueOnce(null)
    await expect((await route().handler(request('202608'), ctx)).json()).resolves.toEqual({ data: null })
  })

  it('answers 400 for a period that is not YYYYMM, without reading anything', async () => {
    const res = await route().handler(request('2026-08'), ctx)

    expect(res.status).toBe(400)
    expect(settingsGet).not.toHaveBeenCalled()
  })
})

describe('awaitingSignatureOf', () => {
  it('reads the stored JSON string and the object form alike', () => {
    const state = { status: 'draft_locked', signeringsLank: SIGNING_URL }
    expect(awaitingSignatureOf(JSON.stringify(state))).toEqual({ signeringsLank: SIGNING_URL, updatedAt: null })
    expect(awaitingSignatureOf(state)).toEqual({ signeringsLank: SIGNING_URL, updatedAt: null })
  })

  it('never hands back a link that is not https, a draft that is only saved, or unreadable state', () => {
    expect(awaitingSignatureOf({ status: 'draft_locked', signeringsLank: 'javascript:alert(1)' })).toBeNull()
    expect(awaitingSignatureOf({ status: 'draft_locked' })).toBeNull()
    expect(awaitingSignatureOf({ status: 'draft_saved', signeringsLank: SIGNING_URL })).toBeNull()
    expect(awaitingSignatureOf('{not json')).toBeNull()
  })
})
