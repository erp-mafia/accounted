/**
 * The core side of the ombud seam: core never imports the skatteverket
 * extension, so it asks through the registry's services. Absent, unwired or
 * failing, the answer is always "no ombud", which is exactly the BankID-only
 * behaviour core had before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const registryGet = vi.hoisted(() => vi.fn())
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { get: registryGet },
}))

import { hasSkatteverketOmbudReadAccess, isSkatteverketOmbudEnabled } from '../ombud-access'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('ombud access through the extension services', () => {
  it('answers no when the extension is not registered', async () => {
    registryGet.mockReturnValue(undefined)
    expect(await isSkatteverketOmbudEnabled()).toBe(false)
    expect(await hasSkatteverketOmbudReadAccess('company-1')).toBe(false)
  })

  it('answers no when the extension does not wire the services', async () => {
    registryGet.mockReturnValue({ id: 'skatteverket', services: {} })
    expect(await isSkatteverketOmbudEnabled()).toBe(false)
    expect(await hasSkatteverketOmbudReadAccess('company-1')).toBe(false)
  })

  it("passes the extension's answers through, per company", async () => {
    const hasOmbudReadAccess = vi.fn(async (companyId: string) => companyId === 'company-1')
    registryGet.mockReturnValue({
      id: 'skatteverket',
      services: { isOmbudEnabled: async () => true, hasOmbudReadAccess },
    })
    expect(await isSkatteverketOmbudEnabled()).toBe(true)
    expect(await hasSkatteverketOmbudReadAccess('company-1')).toBe(true)
    expect(await hasSkatteverketOmbudReadAccess('company-2')).toBe(false)
    expect(registryGet).toHaveBeenCalledWith('skatteverket')
  })

  it('a failing lookup answers no instead of throwing into the page', async () => {
    registryGet.mockReturnValue({
      id: 'skatteverket',
      services: {
        isOmbudEnabled: async () => {
          throw new Error('boom')
        },
        hasOmbudReadAccess: async () => {
          throw new Error('db down')
        },
      },
    })
    expect(await isSkatteverketOmbudEnabled()).toBe(false)
    expect(await hasSkatteverketOmbudReadAccess('company-1')).toBe(false)
  })
})
