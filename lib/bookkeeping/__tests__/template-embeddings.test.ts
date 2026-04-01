import { describe, it, expect } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import { findSimilarTemplates } from '../template-embeddings'

describe('template-embeddings facade', () => {
  describe('findSimilarTemplates', () => {
    it('returns keyword-based matches', async () => {
      const tx = makeTransaction({ description: 'SPOTIFY', amount: -109 })
      const results = await findSimilarTemplates(tx)

      expect(Array.isArray(results)).toBe(true)
    })

    it('accepts entityType parameter', async () => {
      const tx = makeTransaction({ description: 'SPOTIFY', amount: -109 })
      const results = await findSimilarTemplates(tx, 'enskild_firma')

      expect(Array.isArray(results)).toBe(true)
    })
  })
})
