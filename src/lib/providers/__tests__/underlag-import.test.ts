import { describe, expect, it } from 'vitest'
import { supportsUnderlagImport } from '../underlag-import'

describe('supportsUnderlagImport', () => {
  it('names exactly the providers whose underlag the import fetches', () => {
    expect(supportsUnderlagImport('fortnox')).toBe(true)
    expect(supportsUnderlagImport('bokio')).toBe(true)
    for (const provider of ['visma', 'briox', 'bjornlunden', 'wint', '', null, undefined]) {
      expect(supportsUnderlagImport(provider)).toBe(false)
    }
  })
})
