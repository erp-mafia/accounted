import { describe, it, expect } from 'vitest'
import { AUDIT_ONE_IN, auditSample } from '../store'
import { SCHEMAS } from '../schemas'

describe('auditSample', () => {
  it('samples about one settled record in twenty, deterministically, and never a record already in review', () => {
    const def = SCHEMAS['agreement.loan']
    const ids = Array.from({ length: 2000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const sampled = ids.filter((id) => auditSample(id, def, []) !== null)
    expect(sampled.length).toBeGreaterThan(2000 / AUDIT_ONE_IN / 2)
    expect(sampled.length).toBeLessThan((2000 / AUDIT_ONE_IN) * 2)
    expect(auditSample(sampled[0], def, [])).toBe('lender_name')
    expect(auditSample(sampled[0], def, ['principal'])).toBeNull()
    expect(auditSample(sampled[0], def, [])).toBe(auditSample(sampled[0], def, []))
  })
})
