import { describe, it, expect } from 'vitest'
import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import { AiCallTimeoutError } from '@/lib/ai/call-limit'
import { classifyExtractionError } from '../extraction-failure'

/**
 * A provider that could not take the call is the one failure worth reading
 * again by itself; everything else must stay a visible, unretried failure.
 */

function sdkError(status: number, message: string, type?: string) {
  return APIError.generate(status, { type: 'error', error: { type: type ?? 'api_error', message } }, undefined, new Headers())
}

describe('classifyExtractionError', () => {
  it('reads the 2026-10-26 Bedrock answer as the provider being unavailable', () => {
    // What the Bedrock SDK threw for every upload in the outage window.
    const err = APIError.generate(503, { message: 'Bedrock is unable to process your request.' }, undefined, new Headers())
    expect(err.message).toBe('503 Bedrock is unable to process your request.')
    expect(classifyExtractionError(err)).toBe('provider_unavailable')
  })

  it.each([
    [500, 'Internal server error'],
    [502, 'Bad gateway'],
    [529, 'Overloaded'],
    [429, 'Too many requests'],
    [408, 'Request timeout'],
  ])('reads HTTP %i as the provider being unavailable', (status, message) => {
    expect(classifyExtractionError(sdkError(status, message))).toBe('provider_unavailable')
  })

  it.each([
    [400, 'messages.0.content.0.pdf: the PDF specified was not valid'],
    [401, 'invalid x-api-key'],
    [403, 'not authorized to invoke this model'],
    [404, 'model not found'],
    [413, 'request too large'],
  ])('reads HTTP %i as the document or our setup, never the provider', (status, message) => {
    expect(classifyExtractionError(sdkError(status, message, 'invalid_request_error'))).toBe('error')
  })

  it('lets the status decide over a message that sounds like an outage', () => {
    expect(classifyExtractionError(sdkError(400, 'Bedrock is unable to process your request.'))).toBe('error')
  })

  it('reads a dropped connection, with or without a status, as unavailable', () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(classifyExtractionError(new APIConnectionError({ message: 'Connection error.', cause: reset }))).toBe('provider_unavailable')
    expect(classifyExtractionError(new TypeError('fetch failed', { cause: reset }))).toBe('provider_unavailable')
    expect(classifyExtractionError(Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }))).toBe('provider_unavailable')
  })

  it('reads an overloaded or throttled body as unavailable', () => {
    expect(classifyExtractionError({ error: { error: { type: 'overloaded_error' } } })).toBe('provider_unavailable')
    expect(classifyExtractionError(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))).toBe('provider_unavailable')
    expect(classifyExtractionError(new Error('throttled'))).toBe('provider_unavailable')
  })

  it('reads the OpenAI-compatible backend the same way (AI SDK statusCode, RetryError)', () => {
    const callError = Object.assign(new Error('Service Unavailable'), { name: 'AI_APICallError', statusCode: 503 })
    expect(classifyExtractionError(callError)).toBe('provider_unavailable')
    const retryError = Object.assign(new Error('Failed after 3 attempts.'), { name: 'AI_RetryError', lastError: callError })
    expect(classifyExtractionError(retryError)).toBe('provider_unavailable')
    const badRequest = Object.assign(new Error('Bad Request'), { name: 'AI_APICallError', statusCode: 400 })
    expect(classifyExtractionError(Object.assign(new Error('Failed'), { lastError: badRequest }))).toBe('error')
  })

  it('reads the reading deadline as unavailable whatever the abort threw', () => {
    expect(classifyExtractionError(new APIUserAbortError(), { deadlineReached: true })).toBe('provider_unavailable')
    // Without the deadline an abort is not a provider signal.
    expect(classifyExtractionError(new APIUserAbortError())).toBe('error')
  })

  it('reads a call our own time limit ended as unavailable: no answer in time says nothing about the document', () => {
    expect(classifyExtractionError(new AiCallTimeoutError('call_limit', 120_000, new APIUserAbortError()))).toBe('provider_unavailable')
    expect(classifyExtractionError(new AiCallTimeoutError('run_deadline', 40_000))).toBe('provider_unavailable')
  })

  it('reads a parse, schema or configuration failure as an error', () => {
    expect(classifyExtractionError(new SyntaxError('Unexpected token < in JSON at position 0'))).toBe('error')
    expect(classifyExtractionError(new Error('No AI model configured for tier "extraction"'))).toBe('error')
    expect(classifyExtractionError(new Error('Model answered without the forced tool "x"'))).toBe('error')
    expect(classifyExtractionError('a string')).toBe('error')
    expect(classifyExtractionError(null)).toBe('error')
  })

  it('stops on a cause chain that loops', () => {
    const a: Record<string, unknown> = { message: 'a' }
    const b: Record<string, unknown> = { message: 'b', cause: a }
    a.cause = b
    expect(classifyExtractionError(a)).toBe('error')
  })
})
