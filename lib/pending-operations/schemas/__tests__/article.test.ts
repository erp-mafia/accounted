import { describe, it, expect } from 'vitest'
import { CreateArticleParamsSchema, UpdateArticleParamsSchema } from '../article'

const base = { name: 'EU-konsulting', price_excl_vat: 950 }

describe('CreateArticleParamsSchema currency', () => {
  it('accepts and normalizes an ISO code to upper case', () => {
    const parsed = CreateArticleParamsSchema.parse({ ...base, currency: 'eur' })
    expect(parsed.currency).toBe('EUR')
  })

  it('treats empty string and null as unset (commit defaults to SEK)', () => {
    expect(CreateArticleParamsSchema.parse({ ...base, currency: '' }).currency).toBeUndefined()
    expect(CreateArticleParamsSchema.parse({ ...base, currency: null }).currency).toBeUndefined()
    expect(CreateArticleParamsSchema.parse(base).currency).toBeUndefined()
  })

  it('rejects non-ISO shapes', () => {
    expect(() => CreateArticleParamsSchema.parse({ ...base, currency: 'EURO' })).toThrow()
    expect(() => CreateArticleParamsSchema.parse({ ...base, currency: 'E1' })).toThrow()
  })
})

describe('UpdateArticleParamsSchema currency', () => {
  const id = { article_id: '3a9ac4d2-163a-4d43-8fa3-1b32827505fa' }

  it('accepts a currency-only update', () => {
    const parsed = UpdateArticleParamsSchema.parse({ ...id, currency: 'usd' })
    expect(parsed.currency).toBe('USD')
  })

  it('leaves currency undefined when omitted (sparse update must not touch it)', () => {
    const parsed = UpdateArticleParamsSchema.parse({ ...id, name: 'Nytt namn' })
    expect(parsed.currency).toBeUndefined()
  })
})

describe('CreateArticleParamsSchema housework_type', () => {
  it('normalizes a work-type code or bare kind to upper case', () => {
    expect(CreateArticleParamsSchema.parse({ ...base, housework_type: 'stad' }).housework_type).toBe('STAD')
    expect(CreateArticleParamsSchema.parse({ ...base, housework_type: 'rut' }).housework_type).toBe('RUT')
  })

  it('treats empty, whitespace and null as unset', () => {
    expect(CreateArticleParamsSchema.parse({ ...base, housework_type: '' }).housework_type).toBeUndefined()
    expect(CreateArticleParamsSchema.parse({ ...base, housework_type: '  ' }).housework_type).toBeUndefined()
    expect(CreateArticleParamsSchema.parse({ ...base, housework_type: null }).housework_type).toBeUndefined()
  })

  it('rejects free text: the flag would otherwise be silently dead on invoice lines', () => {
    expect(() => CreateArticleParamsSchema.parse({ ...base, housework_type: 'Snickeri' })).toThrow()
    expect(() => CreateArticleParamsSchema.parse({ ...base, housework_type: '1' })).toThrow()
  })
})

describe('UpdateArticleParamsSchema housework_type', () => {
  const id = { article_id: '3a9ac4d2-163a-4d43-8fa3-1b32827505fa' }

  it('accepts a housework_type-only update and normalizes it', () => {
    expect(UpdateArticleParamsSchema.parse({ ...id, housework_type: 'malning' }).housework_type).toBe('MALNING')
  })

  it('leaves housework_type undefined when omitted (sparse update)', () => {
    expect(UpdateArticleParamsSchema.parse({ ...id, name: 'Nytt namn' }).housework_type).toBeUndefined()
  })

  it('null, empty and whitespace-only clear the flag (commit drops only undefined keys)', () => {
    expect(UpdateArticleParamsSchema.parse({ ...id, housework_type: null }).housework_type).toBeNull()
    expect(UpdateArticleParamsSchema.parse({ ...id, housework_type: '' }).housework_type).toBeNull()
    expect(UpdateArticleParamsSchema.parse({ ...id, housework_type: '  ' }).housework_type).toBeNull()
  })

  it('rejects free text on update too', () => {
    expect(() => UpdateArticleParamsSchema.parse({ ...id, housework_type: 'Snickeri' })).toThrow()
  })
})
