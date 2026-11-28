import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The switch persists through POST /api/company/switch, never a server
// action: an action that sets cookies re-renders the page being left and
// streams it back, and the hard navigation that follows aborted that stream
// (Safari and Firefox then showed the error boundary on every client opened
// from the byrå client list).

const markCompanySwitchInFlight = vi.fn()
const markSelfSwitchTarget = vi.fn()
vi.mock('@/lib/company/tab-guard', () => ({
  COMPANY_SWITCH_PATH: '/api/company/switch',
  TAB_SYNC_CHANNEL: 'chan',
  TAB_SYNC_STORAGE_KEY: 'key',
  encodeStorageValue: (id: string) => id,
  markCompanySwitchInFlight: (v: boolean) => markCompanySwitchInFlight(v),
  markSelfSwitchTarget: (id: string | null) => markSelfSwitchTarget(id),
}))

import { companySwitchErrorKey, performCompanySwitch } from '../switch-client'

const COMPANY_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function refusal(code: string, status: number): Response {
  return json({ error: { code, message: 'x', message_en: 'x' } }, status)
}

let fetchMock: ReturnType<typeof vi.fn>
let assign: ReturnType<typeof vi.fn>
let localStorage: ReturnType<typeof memoryStorage>

beforeEach(() => {
  vi.clearAllMocks()
  assign = vi.fn()
  localStorage = memoryStorage()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('window', {
    localStorage,
    location: { assign },
  })
  vi.stubGlobal('BroadcastChannel', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('performCompanySwitch', () => {
  it('POSTs the company to the switch route, notifies other tabs and hard-navigates', async () => {
    let flagDuringRequest: boolean | undefined
    fetchMock.mockImplementation(async () => {
      flagDuringRequest = markCompanySwitchInFlight.mock.lastCall?.[0]
      return json({ data: { company_id: COMPANY_ID } })
    })

    await expect(performCompanySwitch(COMPANY_ID, { destination: '/invoices' })).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/company/switch')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ company_id: COMPANY_ID })
    // The tab guard lets the request through only while the flag is up.
    expect(flagDuringRequest).toBe(true)
    expect(markCompanySwitchInFlight).toHaveBeenLastCalledWith(false)
    expect(markSelfSwitchTarget).toHaveBeenCalledWith(COMPANY_ID)
    expect(localStorage.getItem('key')).toBe(COMPANY_ID)
    expect(assign).toHaveBeenCalledWith('/invoices')
  })

  it('lands on the start page by default', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { company_id: COMPANY_ID } }))
    await performCompanySwitch(COMPANY_ID)
    expect(assign).toHaveBeenCalledWith('/')
  })

  it("lands on the person's start page the switch route answers with", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { company_id: COMPANY_ID, start_path: '/bookkeeping' } }))
    await performCompanySwitch(COMPANY_ID)
    expect(assign).toHaveBeenCalledWith('/bookkeeping')
  })

  it('lets an explicit destination win over the start page', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { company_id: COMPANY_ID, start_path: '/bookkeeping' } }))
    await performCompanySwitch(COMPANY_ID, { destination: '/settings/company' })
    expect(assign).toHaveBeenCalledWith('/settings/company')
  })

  it('follows only a known start page: anything else lands on /', async () => {
    for (const startPath of ['https://evil.example/', '//evil.example', '/settings', 42]) {
      assign.mockClear()
      fetchMock.mockResolvedValueOnce(json({ data: { company_id: COMPANY_ID, start_path: startPath } }))
      await performCompanySwitch(COMPANY_ID)
      expect(assign).toHaveBeenCalledWith('/')
    }
  })

  it.each([
    ['COMPANY_SWITCH_NOT_MEMBER', 403, 'not_member'],
    ['COMPANY_SWITCH_LOCKED', 403, 'company_locked'],
    ['COMPANY_SWITCH_PERSIST_FAILED', 500, 'persist_failed'],
  ])('maps %s to %s without navigating or notifying other tabs', async (code, status, expected) => {
    fetchMock.mockResolvedValueOnce(refusal(code, status))
    await expect(performCompanySwitch(COMPANY_ID)).resolves.toEqual({ error: expected })
    expect(assign).not.toHaveBeenCalled()
    expect(markSelfSwitchTarget).not.toHaveBeenCalled()
    expect(localStorage.getItem('key')).toBeNull()
    expect(markCompanySwitchInFlight).toHaveBeenLastCalledWith(false)
  })

  it('answers Unauthorized when signed out', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
    await expect(performCompanySwitch(COMPANY_ID)).resolves.toEqual({ error: 'Unauthorized' })
    expect(assign).not.toHaveBeenCalled()
  })

  it('reads any other failure as a retryable persist_failed', async () => {
    // MFA step-up (403 with a plain string), a validation 400, the tab
    // guard's own 409, and a non-JSON body.
    fetchMock
      .mockResolvedValueOnce(json({ error: 'MFA verification required' }, 403))
      .mockResolvedValueOnce(json({ error: 'Valideringsfel', type: 'validation_error' }, 400))
      .mockResolvedValueOnce(refusal('ACTIVE_COMPANY_CHANGED', 409))
      .mockResolvedValueOnce(new Response('<html>', { status: 502 }))
    for (let i = 0; i < 4; i++) {
      await expect(performCompanySwitch(COMPANY_ID)).resolves.toEqual({ error: 'persist_failed' })
    }
    expect(assign).not.toHaveBeenCalled()
  })

  it('never navigates on a 200 that does not confirm the company', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('<html>login</html>', { status: 200 }))
      .mockResolvedValueOnce(json({ data: { company_id: 'another-company' } }))
    await expect(performCompanySwitch(COMPANY_ID)).resolves.toEqual({ error: 'persist_failed' })
    await expect(performCompanySwitch(COMPANY_ID)).resolves.toEqual({ error: 'persist_failed' })
    expect(assign).not.toHaveBeenCalled()
  })

  it('answers persist_failed when the request never gets an answer, and clears the guard flag', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Load failed'))
    await expect(performCompanySwitch(COMPANY_ID)).resolves.toEqual({ error: 'persist_failed' })
    expect(markCompanySwitchInFlight).toHaveBeenLastCalledWith(false)
    expect(assign).not.toHaveBeenCalled()
  })
})

describe('companySwitchErrorKey', () => {
  it('names a lost membership and a paused company, and the rest as a failed switch', () => {
    expect(companySwitchErrorKey('not_member')).toBe('error_no_access')
    expect(companySwitchErrorKey('company_locked')).toBe('error_locked')
    expect(companySwitchErrorKey('persist_failed')).toBe('error_switch_failed')
    expect(companySwitchErrorKey('Unauthorized')).toBe('error_switch_failed')
  })
})
