import { describe, it, expect } from 'vitest'
import { AUDIT_ONE_IN_BY_LEVEL, auditOneIn, autonomyLevel, tallyAudits } from '../autonomy'

describe('autonomy ladder', () => {
  it('stays at level 0 until ten audits, then climbs as audited fields stay unchanged', () => {
    expect(autonomyLevel({ audited: 9, changed: 0 })).toBe(0)
    expect(autonomyLevel({ audited: 10, changed: 0 })).toBe(3)
    expect(autonomyLevel({ audited: 100, changed: 2 })).toBe(3)
    expect(autonomyLevel({ audited: 100, changed: 5 })).toBe(2)
    expect(autonomyLevel({ audited: 100, changed: 10 })).toBe(1)
    expect(autonomyLevel({ audited: 100, changed: 11 })).toBe(0)
  })

  it('halves the audit rate per level and falls back to level 0 for anything unknown', () => {
    expect(AUDIT_ONE_IN_BY_LEVEL).toEqual({ 0: 20, 1: 40, 2: 80, 3: 160 })
    expect(auditOneIn(2)).toBe(80)
    expect(auditOneIn(null)).toBe(20)
    expect(auditOneIn(7)).toBe(20)
  })

  it('tallies only reviews that carried an audit, per schema type', () => {
    const tallies = tallyAudits([
      { schema_type: 'agreement.loan', detail: { fields: ['principal'], audit: { field: 'principal', changed: false } } },
      { schema_type: 'agreement.loan', detail: { fields: ['principal'], audit: { field: 'principal', changed: true } } },
      { schema_type: 'agreement.loan', detail: { fields: ['interest_rate'] } },
      { schema_type: 'receipt', detail: { audit: { field: 'total_amount', changed: false } } },
      { schema_type: null, detail: { audit: { changed: false } } },
      { schema_type: 'receipt', detail: null },
    ])
    expect([...tallies.entries()]).toEqual([
      ['agreement.loan', { audited: 2, changed: 1 }],
      ['receipt', { audited: 1, changed: 0 }],
    ])
  })
})
