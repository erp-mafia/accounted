import { describe, it, expect } from 'vitest'
import {
  lossCarryforwardDiscoverable,
  lossCarryforwardEnabledFor,
  lossCarryforwardRollout,
} from '@/lib/env/loss-carryforward-switch'

const A = '0b6a3c9e-1111-4c1a-9f00-000000000001'
const B = '0b6a3c9e-2222-4c1a-9f00-000000000002'

describe('loss carry-forward switch (BOLAGET_COMPANY_IDS)', () => {
  it('is off for everyone while the variable is unset or empty', () => {
    expect(lossCarryforwardRollout({})).toEqual([])
    expect(lossCarryforwardEnabledFor(A, {})).toBe(false)
    expect(lossCarryforwardEnabledFor(A, { BOLAGET_COMPANY_IDS: '  ' })).toBe(false)
    expect(lossCarryforwardDiscoverable({})).toBe(false)
  })

  it('opens every company for *, 1 or true', () => {
    for (const value of ['*', '1', 'true', ' TRUE ']) {
      expect(lossCarryforwardRollout({ BOLAGET_COMPANY_IDS: value })).toBe('all')
      expect(lossCarryforwardEnabledFor(A, { BOLAGET_COMPANY_IDS: value })).toBe(true)
      expect(lossCarryforwardDiscoverable({ BOLAGET_COMPANY_IDS: value })).toBe(true)
    }
  })

  it('opens only the listed companies, case- and space-insensitive', () => {
    const env = { BOLAGET_COMPANY_IDS: ` ${A.toUpperCase()} ,, ` }
    expect(lossCarryforwardEnabledFor(A, env)).toBe(true)
    expect(lossCarryforwardEnabledFor(B, env)).toBe(false)
    expect(lossCarryforwardEnabledFor(null, env)).toBe(false)
    expect(lossCarryforwardDiscoverable(env)).toBe(true)
  })
})
