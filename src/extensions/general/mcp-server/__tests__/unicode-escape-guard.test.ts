/**
 * An agent wrote verifikat text as "Bokf\u00f6ringsorder fr\u00e5n revisor"
 * (the escape sequence itself, not the letters) through create_voucher and
 * correct_entry, and the text reached posted entries in a year that was then
 * closed. These tests pin the decode rule and prove it runs at the single
 * tools/call dispatch point, before any tool sees its arguments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { decodeLiteralUnicodeEscapes, decodeToolArgs } from '../unicode-escape-guard'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
        }
        return () => chain
      },
    },
  )
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['transactions:read', 'reports:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Live Key',
      mode: 'live',
    }),
    createServiceClientNoCookies: vi.fn(() => ({ from: () => chain, rpc: () => chain })),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { handleMcpRequest, tools } from '../server'

// Built with String.raw so the backslashes in the fixtures are literal, the
// way they arrive after JSON.parse of a double-escaped agent payload.
const raw = String.raw

describe('decodeLiteralUnicodeEscapes', () => {
  it('decodes the reported verifikat text', () => {
    expect(decodeLiteralUnicodeEscapes(raw`Bokf\u00f6ringsorder fr\u00e5n revisor Ver 3: Skattekonto - r\u00e4nta/avgifter`))
      .toBe('Bokföringsorder från revisor Ver 3: Skattekonto - ränta/avgifter')
    expect(decodeLiteralUnicodeEscapes(raw`\u00c5terf\u00f6ring`)).toBe('Återföring')
  })

  it('decodes adjacent escapes and mixed real and escaped letters', () => {
    expect(decodeLiteralUnicodeEscapes(raw`\u00e5\u00e4\u00f6`)).toBe('åäö')
    expect(decodeLiteralUnicodeEscapes(raw`Rättelse: Bokf\u00f6ring`)).toBe('Rättelse: Bokföring')
  })

  it('decodes a surrogate pair and leaves a lone surrogate alone', () => {
    expect(decodeLiteralUnicodeEscapes(raw`ok \ud83d\ude00`)).toBe('ok \u{1F600}')
    expect(decodeLiteralUnicodeEscapes(raw`x \ud83d y`)).toBe(raw`x \ud83d y`)
    expect(decodeLiteralUnicodeEscapes(raw`x \ude00 y`)).toBe(raw`x \ude00 y`)
  })

  it('leaves real backslashes and malformed escapes alone', () => {
    for (const s of [
      raw`C:\users\anna`,
      raw`rad 1\nrad 2`,
      raw`\u00g6`,
      raw`slut \u`,
      raw`\u12`,
      'plain text',
      'Återföring',
    ]) {
      expect(decodeLiteralUnicodeEscapes(s)).toBe(s)
    }
  })

  it('leaves an escaped backslash alone so embedded JSON stays valid', () => {
    const json = raw`{"text":"\\u00e5"}`
    expect(decodeLiteralUnicodeEscapes(json)).toBe(json)
    expect(JSON.parse(decodeLiteralUnicodeEscapes(json))).toEqual(JSON.parse(json))
    // Three backslashes: a literal backslash, then a real escape.
    expect(decodeLiteralUnicodeEscapes(raw`a\\\u00e5`)).toBe(raw`a\\` + 'å')
  })

  it('never decodes into a quote, a backslash or a storage-breaking control character', () => {
    for (const s of [raw`\u0022`, raw`\u005c`, raw`\u0000`, raw`\u001b`, raw`\u007f`]) {
      expect(decodeLiteralUnicodeEscapes(s)).toBe(s)
    }
    expect(decodeLiteralUnicodeEscapes(raw`a\u000ab`)).toBe('a\nb')
  })
})

describe('decodeToolArgs', () => {
  it('decodes nested strings (voucher lines) and keeps non-strings', () => {
    const args = {
      description: raw`Moms \u00e5terb\u00e4ring`,
      lines: [{ account_number: '1930', debit: 100, line_description: raw`Bokf\u00f6rt` }],
      dry_run: true,
      notes: null,
    }
    expect(decodeToolArgs(args)).toEqual({
      description: 'Moms återbäring',
      lines: [{ account_number: '1930', debit: 100, line_description: 'Bokfört' }],
      dry_run: true,
      notes: null,
    })
  })

  it('returns the same reference when nothing needs decoding', () => {
    const args = { description: 'Hyra', lines: [{ account_number: '5010' }] }
    expect(decodeToolArgs(args)).toBe(args)
  })

  it('never touches fields that carry a file verbatim', () => {
    const args = {
      file_content: raw`#VER A 1 20250101 "Bokf\u00f6ring"`,
      xml: raw`<a>\u00e5</a>`,
      description: raw`\u00e5`,
    }
    expect(decodeToolArgs(args)).toEqual({ ...args, description: 'å' })
  })
})

describe('tools/call dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('hands every tool decoded arguments', async () => {
    const searchTools = tools.find((t) => t.name === 'gnubok_search_tools')!
    const spy = vi
      .spyOn(searchTools, 'execute')
      .mockResolvedValue({ results: [] } as never)

    await handleMcpRequest(
      new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'gnubok_search_tools', arguments: { query: raw`\u00e5rsbokslut` } },
        }),
      }),
    )

    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0][0] as { query: string }).query).toBe('årsbokslut')
    spy.mockRestore()
  })
})
