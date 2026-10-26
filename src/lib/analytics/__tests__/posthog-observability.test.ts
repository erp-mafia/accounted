import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const posthog = vi.hoisted(() => ({
  captureException: vi.fn(),
  capture: vi.fn(),
}))

vi.mock('../posthog-server', () => ({
  getPostHogServer: () => posthog,
  flushAnalytics: vi.fn(async () => {}),
}))

import { createLogger } from '@/lib/logger'
import { registerObservabilitySink, resetObservabilitySink } from '@/lib/observability/sink'
import { redact } from '@/lib/observability/redact'
import { postHogSink } from '../posthog-observability'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  resetObservabilitySink()
})

describe('postHogSink.captureException', () => {
  it('sends a serialized error as a real Error with its own message, not "[object Object]"', () => {
    const thrown = Object.assign(new Error('Ledger evidence: canceling statement due to statement timeout'), {
      code: '57014',
    })

    postHogSink.captureException(redact(thrown), { module: 'api/x', userId: 'u1' })

    expect(posthog.captureException).toHaveBeenCalledTimes(1)
    const [error, distinctId, properties] = posthog.captureException.mock.calls[0]
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Ledger evidence: canceling statement due to statement timeout')
    expect((error as Error).message).not.toContain('[object Object]')
    expect((error as Error).stack).toContain('posthog-observability.test')
    expect(distinctId).toBe('u1')
    expect(properties).toEqual({ module: 'api/x', userId: 'u1', error_code: '57014' })
  })

  it('leaves error_code out when the error has none', () => {
    postHogSink.captureException(redact(new Error('plain')), { module: 'api/x' })

    const [error, distinctId, properties] = posthog.captureException.mock.calls[0]
    expect((error as Error).message).toBe('plain')
    expect(distinctId).toBeUndefined()
    expect(properties).toEqual({ module: 'api/x' })
  })
})

describe('logger -> sink -> PostHog', () => {
  it('ships a logged error under its own name and message', () => {
    registerObservabilitySink(postHogSink)
    const thrown = new Error('Fortnox API error: 401 Unauthorized')
    thrown.name = 'FortnoxApiError'

    createLogger('extensions/test').error('failed to import a receipt', thrown, { voucher: 'A1' })

    expect(posthog.captureException).toHaveBeenCalledTimes(1)
    const [error, , properties] = posthog.captureException.mock.calls[0]
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('FortnoxApiError')
    expect((error as Error).message).toBe('Fortnox API error: 401 Unauthorized')
    expect(properties).toMatchObject({
      module: 'extensions/test',
      logMessage: 'failed to import a receipt',
      voucher: 'A1',
    })
  })
})
