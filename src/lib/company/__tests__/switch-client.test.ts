import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error'

// A tab opened before a deploy calls switchCompany with the old build's action
// id; the new server answers "Server Action ... was not found on the server"
// and Next.js rejects the call with UnrecognizedActionError (PostHog: 8 in 7
// days, 6 users, all from the company switch). The switch must recover with
// one guarded reload instead of an unhandled rejection and a stuck spinner.

const switchCompany = vi.fn()
vi.mock('@/lib/company/actions', () => ({
  switchCompany: (...args: unknown[]) => switchCompany(...args),
}))

const markCompanySwitchInFlight = vi.fn()
vi.mock('@/lib/company/tab-guard', () => ({
  TAB_SYNC_CHANNEL: 'chan',
  TAB_SYNC_STORAGE_KEY: 'key',
  encodeStorageValue: (id: string) => id,
  markCompanySwitchInFlight: (v: boolean) => markCompanySwitchInFlight(v),
  markSelfSwitchTarget: vi.fn(),
}))

import { companySwitchErrorKey, performCompanySwitch } from '../switch-client'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

let reload: ReturnType<typeof vi.fn>
let assign: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  reload = vi.fn()
  assign = vi.fn()
  vi.stubGlobal('window', {
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    location: { reload, assign },
  })
  vi.stubGlobal('BroadcastChannel', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('performCompanySwitch', () => {
  it('switches and navigates on the normal path', async () => {
    switchCompany.mockResolvedValueOnce({})
    await expect(performCompanySwitch('company-2')).resolves.toBeUndefined()
    expect(assign).toHaveBeenCalledWith('/')
    expect(reload).not.toHaveBeenCalled()
  })

  it('returns the action error without navigating', async () => {
    switchCompany.mockResolvedValueOnce({ error: 'not_member' })
    await expect(performCompanySwitch('company-2')).resolves.toEqual({ error: 'not_member' })
    expect(assign).not.toHaveBeenCalled()
  })

  it('reloads onto the new deploy when the action id is unknown to the server', async () => {
    switchCompany.mockRejectedValueOnce(new UnrecognizedActionError('Server Action "40ab" was not found on the server.'))
    await expect(performCompanySwitch('company-2')).resolves.toBeUndefined()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(assign).not.toHaveBeenCalled()
    // The in-flight flag is always cleared, reload or not.
    expect(markCompanySwitchInFlight).toHaveBeenLastCalledWith(false)
  })

  it('never reloads twice within a minute: the second stale failure returns an error', async () => {
    switchCompany.mockRejectedValue(new UnrecognizedActionError('stale'))
    await performCompanySwitch('company-2')
    await expect(performCompanySwitch('company-2')).resolves.toEqual({ error: 'stale_client' })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload without sessionStorage (no loop guard)', async () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {},
      },
      localStorage: memoryStorage(),
      location: { reload, assign },
    })
    switchCompany.mockRejectedValueOnce(new UnrecognizedActionError('stale'))
    await expect(performCompanySwitch('company-2')).resolves.toEqual({ error: 'stale_client' })
    expect(reload).not.toHaveBeenCalled()
  })

  it('rethrows any other failure unchanged', async () => {
    switchCompany.mockRejectedValueOnce(new Error('network down'))
    await expect(performCompanySwitch('company-2')).rejects.toThrow('network down')
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('companySwitchErrorKey', () => {
  it('names a lost membership and a paused company, and the rest as a failed switch', () => {
    expect(companySwitchErrorKey('not_member')).toBe('error_no_access')
    expect(companySwitchErrorKey('company_locked')).toBe('error_locked')
    expect(companySwitchErrorKey('stale_client')).toBe('error_switch_failed')
    expect(companySwitchErrorKey('anything_else')).toBe('error_switch_failed')
  })
})
