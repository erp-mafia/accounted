import { describe, it, expect } from 'vitest'
import { PackSchema, PackLineSchema, PACK_SLUG_RE } from '@/lib/packs/schema'

const validLine = {
  account: '5010',
  label: 'Lokalhyra',
  side: 'debit' as const,
  type: 'business' as const,
  ratio: 1.0,
}

const validPack = {
  meta: {
    slug: 'lokalhyra',
    order: 1,
    name: 'Lokalhyra',
    description: 'Månadshyra för kontorslokal.',
    category: 'other' as const,
    entity_type: 'all' as const,
  },
  lines: [validLine, { ...validLine, account: '1930', label: 'Företagskonto', side: 'credit' as const, type: 'settlement' as const }],
}

describe('pack schema', () => {
  it('accepts a well-formed pack', () => {
    expect(PackSchema.safeParse(validPack).success).toBe(true)
  })

  it('rejects an unknown top-level key so typos surface instead of being ignored', () => {
    const r = PackSchema.safeParse({ ...validPack, calculators: ['pm_moms'] })
    expect(r.success).toBe(false)
  })

  it('rejects an unknown line key', () => {
    const r = PackSchema.safeParse({
      ...validPack,
      lines: [{ ...validLine, deductibility: 'full' }, validPack.lines[1]],
    })
    expect(r.success).toBe(false)
  })

  it('requires at least two lines: one cannot balance', () => {
    expect(PackSchema.safeParse({ ...validPack, lines: [validLine] }).success).toBe(false)
  })
})

describe('account numbers go through the shared invariant', () => {
  it('rejects a non-four-digit account', () => {
    for (const bad of ['501', '50100', 'abcd', '']) {
      expect(PackLineSchema.safeParse({ ...validLine, account: bad }).success, bad).toBe(false)
    }
  })

  it('rejects a numeric account: BAS numbers are strings', () => {
    expect(PackLineSchema.safeParse({ ...validLine, account: 5010 as never }).success).toBe(false)
  })
})

describe('the vat_rate / ratio split', () => {
  // applyTemplate() computes a vat line from vat_rate and everything else from
  // ratio. Mixing them silently produces the wrong amount, so the schema
  // refuses rather than trusting convention.
  it('requires vat_rate on a vat line', () => {
    const r = PackLineSchema.safeParse({ account: '2641', label: 'Ingående moms', side: 'debit', type: 'vat' })
    expect(r.success).toBe(false)
  })

  it('rejects ratio on a vat line', () => {
    const r = PackLineSchema.safeParse({
      account: '2641', label: 'Ingående moms', side: 'debit', type: 'vat', vat_rate: 0.25, ratio: 1.0,
    })
    expect(r.success).toBe(false)
  })

  it('requires ratio on business and settlement lines', () => {
    for (const type of ['business', 'settlement'] as const) {
      const r = PackLineSchema.safeParse({ account: '5010', label: 'X', side: 'debit', type })
      expect(r.success, type).toBe(false)
    }
  })

  it('rejects vat_rate on a business line', () => {
    const r = PackLineSchema.safeParse({ ...validLine, vat_rate: 0.25 })
    expect(r.success).toBe(false)
  })

  it('accepts a correct vat line', () => {
    const r = PackLineSchema.safeParse({
      account: '2641', label: 'Ingående moms', side: 'debit', type: 'vat', vat_rate: 0.25,
    })
    expect(r.success).toBe(true)
  })
})

describe('slug rule', () => {
  it('accepts lowercase kebab-case', () => {
    for (const ok of ['lokalhyra', 'eu-tjanster-b2b', 'moms-25']) {
      expect(PACK_SLUG_RE.test(ok), ok).toBe(true)
    }
  })

  it('rejects anything that would break a URL or a lookup', () => {
    for (const bad of ['Lokalhyra', 'lokal_hyra', 'lokal hyra', '-lokal', 'lokal-', 'lokal--hyra', 'lokalhyrå']) {
      expect(PACK_SLUG_RE.test(bad), bad).toBe(false)
    }
  })

  it('is enforced by the schema', () => {
    const r = PackSchema.safeParse({ ...validPack, meta: { ...validPack.meta, slug: 'Not A Slug' } })
    expect(r.success).toBe(false)
  })
})

describe('meta.order', () => {
  it('must be a positive integer', () => {
    for (const bad of [0, -1, 1.5]) {
      const r = PackSchema.safeParse({ ...validPack, meta: { ...validPack.meta, order: bad } })
      expect(r.success, String(bad)).toBe(false)
    }
  })
})
