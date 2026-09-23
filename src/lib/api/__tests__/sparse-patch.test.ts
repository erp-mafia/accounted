import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { sparsePatch, sparsePatchBody, isPatchDocument } from '@/lib/api/sparse-patch'
import { validateBody } from '@/lib/api/validate'
import { createMockRequest } from '@/tests/helpers'

// Mirrors the real hazard shape: a create schema carrying .default() flags,
// turned into a patch schema with .partial().
const CreateLine = z.object({
  description: z.string().min(1),
  amount: z.number(),
  quantity: z.number().optional(),
  is_taxable: z.boolean().default(true),
  is_net_deduction: z.boolean().default(false),
  sort_order: z.number().int().default(0),
  account_number: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  meta: z.object({ source: z.string().default('manual') }).default({ source: 'manual' }),
})

const UpdateLine = CreateLine.partial()

describe('the bug this helper exists for', () => {
  it('.partial() does NOT strip .default(): a one-field parse resurrects every default', () => {
    // This is the finding, pinned as an executable fact. If a future zod
    // upgrade changes it, this test tells you the helper can be retired.
    expect(UpdateLine.parse({ amount: 5500 })).toEqual({
      amount: 5500,
      is_taxable: true,
      is_net_deduction: false,
      sort_order: 0,
      tags: [],
      meta: { source: 'manual' },
    })
  })
})

describe('sparsePatch', () => {
  it('a one-field patch does not resurrect defaults', () => {
    const result = sparsePatch(UpdateLine, { amount: 5500 })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ amount: 5500 })
    expect(Object.keys(result.data)).toEqual(['amount'])
  })

  it('keeps a default-carrying field when the caller DID send it', () => {
    const result = sparsePatch(UpdateLine, { is_taxable: false })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ is_taxable: false })
  })

  it('an explicit null survives as a deliberate clear', () => {
    const result = sparsePatch(UpdateLine, { account_number: null })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ account_number: null })
    expect('account_number' in result.data).toBe(true)
  })

  it('an absent key is untouched (never appears in the output)', () => {
    const result = sparsePatch(UpdateLine, { description: 'Bonus' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect('account_number' in result.data).toBe(false)
    expect('is_taxable' in result.data).toBe(false)
    expect('sort_order' in result.data).toBe(false)
  })

  it('null and absent are distinguishable, which is the whole point', () => {
    const cleared = sparsePatch(UpdateLine, { account_number: null })
    const untouched = sparsePatch(UpdateLine, {})
    expect(cleared.success && cleared.data).toEqual({ account_number: null })
    expect(untouched.success && untouched.data).toEqual({})
  })

  it('drops an in-process undefined (not expressible in JSON, never intended)', () => {
    const result = sparsePatch(UpdateLine, { amount: 1, quantity: undefined })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ amount: 1 })
    expect('quantity' in result.data).toBe(false)
  })

  it('drops unknown keys rather than passing them to the caller', () => {
    const result = sparsePatch(UpdateLine, { amount: 1, is_system: true, company_id: 'other' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ amount: 1 })
  })

  it('drops prototype-polluting own properties from a JSON body', () => {
    const rawBody = JSON.parse('{"amount": 1, "__proto__": {"polluted": true}}')
    const result = sparsePatch(UpdateLine, rawBody)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ amount: 1 })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  describe('nested objects', () => {
    it('an absent nested key stays absent (its inner defaults do not materialise)', () => {
      const result = sparsePatch(UpdateLine, { amount: 1 })
      expect(result.success && 'meta' in result.data).toBe(false)
    })

    it('a supplied nested key is replaced wholesale, inner defaults included', () => {
      // Shallow by design: the sink is `SET col = $1`, which replaces the whole
      // jsonb value, so a half-merged object would write something the caller
      // never described.
      const result = sparsePatch(UpdateLine, { meta: {} })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data).toEqual({ meta: { source: 'manual' } })
    })

    it('reports validation errors with their full nested path', () => {
      const result = sparsePatch(UpdateLine, { meta: { source: 42 } })
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0].path).toEqual(['meta', 'source'])
    })
  })

  describe('arrays', () => {
    it('an array VALUE is taken wholesale', () => {
      const result = sparsePatch(UpdateLine, { tags: ['a', 'b'] })
      expect(result.success && result.data).toEqual({ tags: ['a', 'b'] })
    })

    it('an explicitly empty array is a real value, not an absence', () => {
      const result = sparsePatch(UpdateLine, { tags: [] })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data).toEqual({ tags: [] })
      expect('tags' in result.data).toBe(true)
    })

    it('an array BODY is rejected: a patch document must be a JSON object', () => {
      const result = sparsePatch(UpdateLine, [{ amount: 1 }])
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0].message).toContain('JSON object')
    })
  })

  it.each([
    ['null', null],
    ['a scalar', 42],
    ['a string', 'amount=1'],
  ])('rejects %s as a body', (_label, body) => {
    expect(sparsePatch(UpdateLine, body).success).toBe(false)
  })

  it('propagates schema validation failures unchanged', () => {
    const result = sparsePatch(UpdateLine, { amount: 'not a number' })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0].path).toEqual(['amount'])
  })

  it('throws when the schema output is not an object (there is nothing to narrow)', () => {
    const Reshaped = z.object({ a: z.number().optional() }).transform(() => null)
    expect(() => sparsePatch(Reshaped, { a: 1 })).toThrow(/output is an object/)
  })

  it('works on a .superRefine()-wrapped schema (where .shape is unreachable)', () => {
    const Refined = CreateLine.partial().superRefine((data, ctx) => {
      if (data.amount === 13) {
        ctx.addIssue({ code: 'custom', message: 'Olyckstal', path: ['amount'] })
      }
    })
    expect(sparsePatch(Refined, { amount: 1 }).success && sparsePatch(Refined, { amount: 1 })).toMatchObject({
      data: { amount: 1 },
    })
    const bad = sparsePatch(Refined, { amount: 13 })
    expect(bad.success).toBe(false)
    if (bad.success) return
    expect(bad.error.issues[0].path).toEqual(['amount'])
  })
})

describe('isPatchDocument', () => {
  it.each([
    [{}, true],
    [{ a: 1 }, true],
    [[], false],
    [null, false],
    [1, false],
    ['x', false],
    [undefined, false],
  ])('%s -> %s', (input, expected) => {
    expect(isPatchDocument(input)).toBe(expected)
  })
})

describe('sparsePatchBody + validateBody', () => {
  async function patch(body: unknown) {
    const request = createMockRequest('/api/thing/1', { method: 'PATCH', body })
    return validateBody(request, sparsePatchBody(UpdateLine))
  }

  it('yields only the sent keys through the validateBody pipeline', async () => {
    const result = await patch({ amount: 5500 })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ amount: 5500 })
  })

  it('keeps an explicit null through the validateBody pipeline', async () => {
    const result = await patch({ account_number: null })
    expect(result.success && result.data).toEqual({ account_number: null })
  })

  it('returns a 400 with the original field path on a schema failure', async () => {
    const result = await patch({ amount: 'x' })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.response.status).toBe(400)
    const body = await result.response.json()
    expect(body.errors[0].field).toBe('amount')
  })

  // Forwarding through ctx.addIssue must not flatten the issue to `custom`:
  // validateBody puts `code` in the 400 envelope and clients branch on it.
  it('keeps the original issue CODE, not a flattened `custom`', async () => {
    const result = await patch({ amount: 'x' })
    expect(result.success).toBe(false)
    if (result.success) return
    const body = await result.response.json()
    expect(body.errors[0].code).toBe('invalid_type')
    expect(body.errors[0].code).not.toBe('custom')
  })

  it('forwards every issue, each with its own nested path and code', async () => {
    const result = await patch({ meta: { source: 1 }, description: '' })
    expect(result.success).toBe(false)
    if (result.success) return
    const body = await result.response.json()
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'meta.source', code: 'invalid_type' }),
        expect.objectContaining({ field: 'description', code: 'too_small' }),
      ]),
    )
  })

  it('produces the same issues a plain validateBody(schema) would', async () => {
    const bare = await validateBody(
      createMockRequest('/api/thing/1', { method: 'PATCH', body: { amount: 'x' } }),
      UpdateLine,
    )
    const sparse = await patch({ amount: 'x' })
    expect(bare.success).toBe(false)
    expect(sparse.success).toBe(false)
    if (bare.success || sparse.success) return
    expect(await sparse.response.json()).toEqual(await bare.response.json())
  })

  it('returns a 400 when the body is not a JSON object', async () => {
    const result = await patch([1, 2])
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.response.status).toBe(400)
  })

  it('an empty body parses to an empty patch, not to a pile of defaults', async () => {
    const result = await patch({})
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({})
  })
})
