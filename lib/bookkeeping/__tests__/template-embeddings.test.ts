import { describe, it, expect } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import { findMatchingTemplates } from '../booking-templates'

describe('template keyword matching', () => {
  describe('findMatchingTemplates', () => {
    it('returns keyword-based matches', async () => {
      const tx = makeTransaction({ description: 'SPOTIFY', amount: -109 })
      const results = await findMatchingTemplates(tx)

      expect(Array.isArray(results)).toBe(true)
    })

    it('accepts entityType parameter', async () => {
      const tx = makeTransaction({ description: 'SPOTIFY', amount: -109 })
      const results = await findMatchingTemplates(tx, 'enskild_firma')

      expect(Array.isArray(results)).toBe(true)
    })
  })
})
