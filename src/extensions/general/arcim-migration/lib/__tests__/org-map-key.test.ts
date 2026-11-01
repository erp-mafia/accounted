import { describe, expect, it } from 'vitest'
import { orgMapKey } from '../migration-orchestrator'

describe('orgMapKey: the supplier map of the legacy migration', () => {
  it('finds one supplier from every Swedish written form', () => {
    expect(orgMapKey('16556677-8899')).toBe(orgMapKey('5566778899'))
    expect(orgMapKey('556677-8899')).toBe(orgMapKey('5566778899'))
  })

  it('keeps two countries with the same digits apart, and one number written twice together', () => {
    expect(orgMapKey('BE0123456789')).not.toBe(orgMapKey('FR0123456789'))
    expect(orgMapKey('be 0123456789')).toBe(orgMapKey('BE0123456789'))
  })
})
