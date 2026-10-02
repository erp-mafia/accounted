import { describe, it, expect } from 'vitest'
import { CreateArticleParamsSchema, UpdateArticleParamsSchema } from '../article'

describe('article params: grön teknik installation types', () => {
  it('accepts and upper-cases an installation type on create and update', () => {
    expect(
      CreateArticleParamsSchema.parse({ name: 'Solpanel', price_excl_vat: 2400, type: 'vara', housework_type: 'installation_solceller' })
        .housework_type,
    ).toBe('INSTALLATION_SOLCELLER')
    expect(
      UpdateArticleParamsSchema.parse({ article_id: '3a9ac4d2-163a-4d43-8fa3-1b32827505fa', housework_type: 'INSTALLATION_LAGRING' })
        .housework_type,
    ).toBe('INSTALLATION_LAGRING')
  })

  it('refuses a bare grön teknik kind, listing the installation types', () => {
    const result = CreateArticleParamsSchema.safeParse({ name: 'Solpanel', price_excl_vat: 2400, housework_type: 'GRON_TEKNIK' })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0].message).toContain('INSTALLATION_LADDPUNKT')
  })
})
