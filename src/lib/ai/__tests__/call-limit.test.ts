import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// A Bedrock client whose request never answers: it ends only when its signal fires.
const mockCreate = vi.fn(
  (_params: unknown, options?: { signal?: AbortSignal }) =>
    new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')))
    }),
)
vi.mock('@anthropic-ai/bedrock-sdk', () => {
  class FakeBedrock {
    messages = { create: mockCreate }
  }
  return { default: FakeBedrock }
})

import { AI_CALL_LIMIT_MS, AiCallTimeoutError, currentAiDeadline, isRunDeadlineCut, withAiDeadline, withCallLimit } from '../call-limit'
import { getAiService } from '../index'
import { aiCallLimitMs } from '../config'
import { classifyExtractionError } from '@/lib/documents/inbox-extraction/extraction-failure'
import type { AiService } from '../types'

/**
 * Every structured answer and document reading has a time limit, and a run
 * can set a moment no model call may pass. Before, the only limit was the
 * SDK's ten minutes a try, in functions that are killed at 300 s.
 */

/** A model that answers only when its request is aborted, the way a hung provider call behaves. */
function hangingService() {
  const seen: Array<AbortSignal | undefined> = []
  const hang = (req: { signal?: AbortSignal }) =>
    new Promise<never>((_resolve, reject) => {
      seen.push(req.signal)
      req.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')))
    })
  const service = {
    provider: 'bedrock',
    capabilities: {},
    modelFor: () => 'model',
    generateText: hang,
    generateStructured: hang,
    extractFromDocument: hang,
  } as unknown as AiService
  return { service: withCallLimit(service), seen }
}

const STRUCTURED = { tier: 'cheap' as const, prompt: 'p', maxTokens: 10, schema: { name: 's', jsonSchema: {} } }
const DOCUMENT = { document: { kind: 'text' as const, text: 'x' }, system: 's', instruction: 'i', maxTokens: 10 }

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }))
afterEach(() => vi.useRealTimers())

describe('withCallLimit', () => {
  it('ends a structured call that hangs at the limit, as a failure the queue reads as the provider being unavailable', async () => {
    const { service } = hangingService()
    const call = service.generateStructured(STRUCTURED).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(AI_CALL_LIMIT_MS - 1)
    await vi.advanceTimersByTimeAsync(1)
    const err = await call
    expect(err).toBeInstanceOf(AiCallTimeoutError)
    expect((err as Error).message).toMatch(/^Request timed out/)
    expect(classifyExtractionError(err)).toBe('provider_unavailable')
    // Its own limit, not a run's deadline: the provider gave no answer.
    expect((err as AiCallTimeoutError).cut).toBe('call_limit')
    expect(isRunDeadlineCut(err)).toBe(false)
  })

  it('ends the wait at the limit even when the call does not notice its signal (the SDK sleeping between retries)', async () => {
    const deaf = { generateStructured: () => new Promise<never>(() => undefined) } as unknown as AiService
    const call = withCallLimit(deaf).generateStructured(STRUCTURED).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(AI_CALL_LIMIT_MS)
    expect(await call).toBeInstanceOf(AiCallTimeoutError)
  })

  it('takes the limit it is given: a deployment with a slow model raises it', async () => {
    const hang = (req: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    const service = withCallLimit({ generateStructured: hang, extractFromDocument: hang } as unknown as AiService, 300_000)
    let ended = false
    const call = service.generateStructured(STRUCTURED).catch((err: unknown) => { ended = true; return err })
    await vi.advanceTimersByTimeAsync(AI_CALL_LIMIT_MS * 2)
    expect(ended).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await call).toBeInstanceOf(AiCallTimeoutError)
  })

  it('ends a document reading that hangs at the limit', async () => {
    const { service } = hangingService()
    const call = service.extractFromDocument(DOCUMENT).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(AI_CALL_LIMIT_MS)
    expect(await call).toBeInstanceOf(AiCallTimeoutError)
  })

  it('returns the answer of a call that ends in time, and passes it a signal to end by', async () => {
    const generateStructured = vi.fn(async () => ({ value: { ok: true }, model: 'm', usage: {} }))
    const service = withCallLimit({ generateStructured } as unknown as AiService)
    await expect(service.generateStructured(STRUCTURED)).resolves.toMatchObject({ value: { ok: true } })
    expect((generateStructured.mock.calls[0] as unknown as [{ signal?: AbortSignal }])[0].signal).toBeInstanceOf(AbortSignal)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves a caller with a signal of its own to its own limit', async () => {
    const { service, seen } = hangingService()
    const own = new AbortController()
    const call = service.extractFromDocument({ ...DOCUMENT, signal: own.signal }).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(AI_CALL_LIMIT_MS * 2)
    expect(seen[0]).toBe(own.signal)
    own.abort()
    // The caller's own abort comes back as its own: the caller knows its signal fired.
    expect(await call).not.toBeInstanceOf(AiCallTimeoutError)
  })

  it('ends the wait at the caller\'s own signal even when the call does not notice it (the inbox reading\'s 250 s)', async () => {
    const deaf = { extractFromDocument: () => new Promise<never>(() => undefined) } as unknown as AiService
    // The caller's own deadline, as the inbox reading sets it (a timer here, so the test's clock drives it).
    const own = new AbortController()
    setTimeout(() => own.abort(), 250_000)
    let ended = false
    const call = withCallLimit(deaf).extractFromDocument({ ...DOCUMENT, signal: own.signal }).catch((err: unknown) => { ended = true; return err })
    await vi.advanceTimersByTimeAsync(249_000)
    expect(ended).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    const err = await call
    // The signal's own reason, so the caller reads it the way it reads its own abort.
    expect(err).toBe(own.signal.reason)
    expect(err).not.toBeInstanceOf(AiCallTimeoutError)
  })

  it('refuses at once a call whose caller\'s signal has already fired', async () => {
    const { service, seen } = hangingService()
    const own = new AbortController()
    own.abort()
    await expect(service.generateStructured({ ...STRUCTURED, signal: own.signal })).rejects.toBe(own.signal.reason)
    expect(seen).toEqual([])
  })

  it('sets no limit of its own on a text answer: a tool loop is its caller\'s to bound', async () => {
    const generateText = vi.fn(async () => ({ text: 'ok', model: 'm', usage: {} }))
    const service = withCallLimit({ generateText } as unknown as AiService)
    await service.generateText({ tier: 'cheap', prompt: 'p', maxTokens: 10 })
    expect(generateText.mock.calls[0]).toEqual([{ tier: 'cheap', prompt: 'p', maxTokens: 10 }])
  })
})

describe('withAiDeadline', () => {
  it('gives a call started late only what is left of the run', async () => {
    const { service } = hangingService()
    const call = withAiDeadline(Date.now() + 30_000, () => service.generateStructured(STRUCTURED)).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(30_000)
    const err = await call
    expect(err).toBeInstanceOf(AiCallTimeoutError)
    // Told apart from the call's own limit, as an error and as the text a job keeps of it.
    expect((err as AiCallTimeoutError).cut).toBe('run_deadline')
    expect(isRunDeadlineCut(err)).toBe(true)
    expect(isRunDeadlineCut(`reader_unavailable: ${(err as Error).message}`)).toBe(true)
    expect(isRunDeadlineCut('reader_unavailable: 503 Bedrock is unable to process your request.')).toBe(false)
  })

  it('says the call\'s own limit when that comes before the deadline', async () => {
    const { service } = hangingService()
    const call = withAiDeadline(Date.now() + AI_CALL_LIMIT_MS + 60_000, () => service.generateStructured(STRUCTURED)).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(AI_CALL_LIMIT_MS)
    expect(((await call) as AiCallTimeoutError).cut).toBe('call_limit')
  })

  it('never reaches past the deadline of the scope around it', async () => {
    const outer = Date.now() + 10_000
    const inner = await withAiDeadline(outer, () => withAiDeadline(outer + 60_000, async () => currentAiDeadline()))
    expect(inner).toBe(outer)
    const tighter = await withAiDeadline(outer, () => withAiDeadline(outer - 5_000, async () => currentAiDeadline()))
    expect(tighter).toBe(outer - 5_000)
  })

  it('ends every kind of call at the deadline: a text answer, and a reading with a signal of its own', async () => {
    const { service } = hangingService()
    const own = new AbortController()
    const calls = withAiDeadline(Date.now() + 30_000, () =>
      Promise.all([
        service.generateText({ tier: 'cheap', prompt: 'p', maxTokens: 10 }).catch((err: unknown) => err),
        service.extractFromDocument({ ...DOCUMENT, signal: own.signal }).catch((err: unknown) => err),
      ]),
    )
    await vi.advanceTimersByTimeAsync(30_000)
    const [text, reading] = await calls
    expect(text).toBeInstanceOf(AiCallTimeoutError)
    expect(reading).toBeInstanceOf(AiCallTimeoutError)
  })

  it('refuses a call that would start after the deadline, without reaching the model', async () => {
    const { service, seen } = hangingService()
    const err = await withAiDeadline(Date.now() - 1, () => service.generateStructured(STRUCTURED)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AiCallTimeoutError)
    expect(seen).toEqual([])
    expect(classifyExtractionError(err)).toBe('provider_unavailable')
    expect(isRunDeadlineCut(err)).toBe(true)
  })

  it('reaches calls made layers below, across awaits', async () => {
    const { service } = hangingService()
    const deep = async () => {
      await Promise.resolve()
      return service.generateStructured(STRUCTURED)
    }
    const call = withAiDeadline(Date.now() + 5_000, async () => (await Promise.all([deep(), deep()])).length).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await call).toBeInstanceOf(AiCallTimeoutError)
  })
})

describe('getAiService', () => {
  it('hands every caller the limited service: a hung Bedrock request ends at the limit', async () => {
    vi.stubEnv('AI_PROVIDER', 'bedrock')
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAEXAMPLE')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret')
    try {
      const call = getAiService().generateStructured(STRUCTURED).catch((err: unknown) => err)
      await vi.advanceTimersByTimeAsync(AI_CALL_LIMIT_MS)
      expect(await call).toBeInstanceOf(AiCallTimeoutError)
      expect(mockCreate).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reads the limit from AI_CALL_TIMEOUT_SECONDS, for a self-hosted model that answers slowly', async () => {
    expect(aiCallLimitMs()).toBe(AI_CALL_LIMIT_MS)
    vi.stubEnv('AI_PROVIDER', 'bedrock')
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAEXAMPLE')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret')
    vi.stubEnv('AI_CALL_TIMEOUT_SECONDS', '300')
    try {
      expect(aiCallLimitMs()).toBe(300_000)
      let ended = false
      const call = getAiService().generateStructured(STRUCTURED).catch((err: unknown) => { ended = true; return err })
      await vi.advanceTimersByTimeAsync(AI_CALL_LIMIT_MS * 2)
      expect(ended).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await call).toBeInstanceOf(AiCallTimeoutError)
      // Not a number, or not positive: the default, never no limit.
      vi.stubEnv('AI_CALL_TIMEOUT_SECONDS', '0')
      expect(aiCallLimitMs()).toBe(AI_CALL_LIMIT_MS)
      vi.stubEnv('AI_CALL_TIMEOUT_SECONDS', 'soon')
      expect(aiCallLimitMs()).toBe(AI_CALL_LIMIT_MS)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
