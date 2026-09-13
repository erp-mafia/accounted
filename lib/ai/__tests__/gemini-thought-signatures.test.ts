import { describe, it, expect, vi } from 'vitest'
import {
  SKIP_THOUGHT_SIGNATURE_VALIDATOR,
  attachThoughtSignatures,
  collectThoughtSignatures,
  collectThoughtSignaturesFromSse,
  wrapGeminiThoughtSignatureFetch,
} from '../gemini-thought-signatures'

const SIG = 'CtQBAePx-repro-signature'

function jsonResponse(body: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': contentType } })
}

function geminiToolTurn(id: string, signature: string | null) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id,
              type: 'function',
              function: { name: 'get_income_statement', arguments: '{"year":2025}' },
              ...(signature
                ? { extra_content: { google: { thought_signature: signature } } }
                : {}),
            },
          ],
        },
      },
    ],
  }
}

function turn2Body(toolCallId: string): string {
  return JSON.stringify({
    model: 'gemini-3.8-flash',
    messages: [
      { role: 'user', content: 'Resultat 2025?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: toolCallId,
            type: 'function',
            function: { name: 'get_income_statement', arguments: '{"year":2025}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: toolCallId, content: '{"net":-1291.71}' },
    ],
  })
}

describe('collectThoughtSignatures', () => {
  it('stores extra_content.google.thought_signature by tool-call id', () => {
    const signatures = new Map<string, string>()
    collectThoughtSignatures(geminiToolTurn('call-1', SIG), signatures)
    expect(signatures.get('call-1')).toBe(SIG)
  })

  it('ignores a completion with no extra_content (Berget, Qwen, llama.cpp)', () => {
    const signatures = new Map<string, string>()
    collectThoughtSignatures(geminiToolTurn('call-1', null), signatures)
    expect(signatures.size).toBe(0)
  })

  it('joins a streamed tool-call id chunk with a later extra_content chunk', () => {
    const signatures = new Map<string, string>()
    const sse = [
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  function: { name: 'get_income_statement', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  extra_content: { google: { thought_signature: SIG } },
                },
              ],
            },
          },
        ],
      }),
    ]
      .map((payload) => `data: ${payload}`)
      .concat('data: [DONE]')
      .join('\n')
    collectThoughtSignaturesFromSse(sse, signatures)
    expect(signatures.get('call-1')).toBe(SIG)
  })
})

describe('attachThoughtSignatures', () => {
  it('leaves the body unchanged when nothing has been harvested', () => {
    const body = turn2Body('call-1')
    expect(attachThoughtSignatures(body, new Map())).toBe(body)
  })

  it('reattaches the harvested signature on the next assistant tool call', () => {
    const signatures = new Map([['call-1', SIG]])
    const patched = JSON.parse(attachThoughtSignatures(turn2Body('call-1'), signatures))
    expect(patched.messages[1].tool_calls[0].extra_content.google.thought_signature).toBe(SIG)
  })

  it('does not overwrite a signature already on the wire', () => {
    const signatures = new Map([['call-1', 'other']])
    const body = JSON.stringify({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call-1',
              extra_content: { google: { thought_signature: SIG } },
            },
          ],
        },
      ],
    })
    expect(attachThoughtSignatures(body, signatures)).toBe(body)
  })

  it('uses the skip sentinel for a tool call whose id was not harvested, once any signature has been seen', () => {
    const signatures = new Map([['call-other', SIG]])
    const patched = JSON.parse(attachThoughtSignatures(turn2Body('call-unknown'), signatures))
    expect(patched.messages[1].tool_calls[0].extra_content.google.thought_signature).toBe(
      SKIP_THOUGHT_SIGNATURE_VALIDATOR,
    )
  })

  it('returns non-JSON bodies unchanged', () => {
    expect(attachThoughtSignatures('not-json', new Map([['x', SIG]]))).toBe('not-json')
  })
})

describe('wrapGeminiThoughtSignatureFetch', () => {
  it('harvests a JSON tool-call response and echoes extra_content on the next request', async () => {
    const inner = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(geminiToolTurn('call-1', SIG)))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))

    const fetch = wrapGeminiThoughtSignatureFetch(inner)

    await fetch('https://example.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    })
    await fetch('https://example.test/v1/chat/completions', {
      method: 'POST',
      body: turn2Body('call-1'),
    })

    const secondInit = inner.mock.calls[1][1] as RequestInit
    const sent = JSON.parse(String(secondInit.body))
    expect(sent.messages[1].tool_calls[0].extra_content.google.thought_signature).toBe(SIG)
  })

  it('does not rewrite a follow-up when the first response had no extra_content', async () => {
    const inner = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(geminiToolTurn('call-1', null)))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))

    const fetch = wrapGeminiThoughtSignatureFetch(inner)
    await fetch('https://example.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    })
    const followUp = turn2Body('call-1')
    await fetch('https://example.test/v1/chat/completions', { method: 'POST', body: followUp })

    const secondInit = inner.mock.calls[1][1] as RequestInit
    expect(secondInit.body).toBe(followUp)
  })

  it('harvests extra_content from SSE chunks before the next request', async () => {
    const sse = [
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'get_income_statement', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, extra_content: { google: { thought_signature: SIG } } },
              ],
            },
          },
        ],
      }),
    ]
      .map((payload) => `data: ${payload}`)
      .concat('data: [DONE]', '')
      .join('\n')
    const inner = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))

    const fetch = wrapGeminiThoughtSignatureFetch(inner)
    await fetch('https://example.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'x' }] }),
    })
    await fetch('https://example.test/v1/chat/completions', {
      method: 'POST',
      body: turn2Body('call-1'),
    })

    const secondInit = inner.mock.calls[1][1] as RequestInit
    const sent = JSON.parse(String(secondInit.body))
    expect(sent.messages[1].tool_calls[0].extra_content.google.thought_signature).toBe(SIG)
  })
})
