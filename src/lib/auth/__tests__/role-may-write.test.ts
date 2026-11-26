import { describe, expect, it } from 'vitest'
import { roleMayWrite } from '../role-may-write'

describe('roleMayWrite', () => {
  it('lets every role but the read-only one write', () => {
    expect(roleMayWrite('owner')).toBe(true)
    expect(roleMayWrite('admin')).toBe(true)
    expect(roleMayWrite('member')).toBe(true)
    expect(roleMayWrite('viewer')).toBe(false)
  })

  it('does not let someone with no role write', () => {
    expect(roleMayWrite(null)).toBe(false)
    expect(roleMayWrite(undefined)).toBe(false)
  })
})
