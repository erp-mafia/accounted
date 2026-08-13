import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events'
import {
  getPeppolTransport,
  getPeppolTransportAvailability,
  registerPeppolTransport,
  type PeppolTransport,
} from '../peppol-transport'

function makeTransport(provider: string): PeppolTransport {
  return {
    provider,
    lookupRecipient: vi.fn(),
    submit: vi.fn(),
    verifyWebhook: vi.fn(),
    retrieveEvidence: vi.fn(),
  }
}

describe('Peppol transport registry', () => {
  const cleanups: Array<() => void> = []
  const originalProvider = process.env.PEPPOL_TRANSPORT_PROVIDER

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
  })

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
    if (originalProvider === undefined) {
      delete process.env.PEPPOL_TRANSPORT_PROVIDER
    } else {
      process.env.PEPPOL_TRANSPORT_PROVIDER = originalProvider
    }
  })

  it('stays truthfully unavailable until a provider is selected', () => {
    expect(getPeppolTransportAvailability()).toEqual({
      available: false,
      provider: null,
      reason: 'provider_selection_required',
    })
  })

  it('does not claim availability for a configured but absent adapter', () => {
    process.env.PEPPOL_TRANSPORT_PROVIDER = 'storecove'

    expect(getPeppolTransportAvailability()).toEqual({
      available: false,
      provider: null,
      reason: 'provider_adapter_unavailable',
    })
  })

  it('registers and removes an explicit adapter without a core default', () => {
    const transport = makeTransport('Storecove')
    cleanups.push(registerPeppolTransport(transport))
    process.env.PEPPOL_TRANSPORT_PROVIDER = 'storecove'

    expect(getPeppolTransport('STORECOVE')).toBe(transport)
    expect(getPeppolTransportAvailability()).toEqual({
      available: true,
      provider: 'storecove',
    })
  })

  it('rejects duplicate provider registrations', () => {
    cleanups.push(registerPeppolTransport(makeTransport('qvalia')))
    expect(() => registerPeppolTransport(makeTransport('QVALIA')))
      .toThrow('Peppol transport already registered: qvalia')
  })
})
