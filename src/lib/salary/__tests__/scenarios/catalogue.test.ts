/**
 * Integrity of the payroll scenario catalogue itself: ids, citations,
 * published anchors and the internal arithmetic of the todo data, so a
 * scenario cannot rot while it waits for its feature.
 */
import { describe, expect, it } from 'vitest'
import { roundOre } from '@/lib/money'
import type { Scenario } from './catalogue'
import { AGREEMENT_SCENARIOS } from './agreements.scenarios'
import { LAW_SCENARIOS } from './law-baseline.scenarios'
import { LIABILITY_SCENARIOS } from './vacation-liability.scenarios'

const ALL: Scenario[] = [...LAW_SCENARIOS, ...LIABILITY_SCENARIOS, ...AGREEMENT_SCENARIOS]
const PREFIX = { 'law-baseline': 'LB', 'vacation-liability': 'VL', agreement: 'AG' } as const

describe('payroll scenario catalogue', () => {
  it('has unique ids matching their area', () => {
    const ids = ALL.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of ALL) expect(s.id).toMatch(new RegExp(`^${PREFIX[s.area]}-\\d{2}$`))
  })

  it('gives every scenario a formula and at least one source, every suspected bug a note and every todo its missing capability', () => {
    for (const s of ALL) {
      expect(s.formula.length, s.id).toBeGreaterThan(20)
      expect(s.sources.length, s.id).toBeGreaterThan(0)
      for (const src of s.sources) expect(src.ref.length, s.id).toBeGreaterThan(0)
      if (s.status === 'engine-bug') expect(s.note?.length ?? 0, s.id).toBeGreaterThan(40)
      if (s.status === 'todo') expect(s.todoReason?.length ?? 0, s.id).toBeGreaterThan(20)
    }
  })

  it('reproduces every published worked example from the cited formula', () => {
    for (const s of ALL) {
      for (const a of s.anchors ?? []) {
        expect(Math.abs(a.computed - a.published), `${s.id}: ${a.label}`).toBeLessThanOrEqual(a.tolerance)
      }
    }
  })

  it('carries no em or en dash (CLAUDE.md)', () => {
    for (const s of ALL) expect(JSON.stringify(s), s.id).not.toMatch(/[\u2013\u2014]/)
  })

  it('keeps the todo premium data internally consistent', () => {
    for (const s of AGREEMENT_SCENARIOS) {
      if (s.kind !== 'premium') continue
      const rules = new Map(s.inputs.rules.map((r) => [r.id, r]))
      let sum = 0
      for (const line of s.expected.lines) {
        expect(line.amount, `${s.id} ${line.rule}`).toBe(roundOre(line.hours * line.ratePerHour))
        expect(line.hours, `${s.id} ${line.rule}`).toBeGreaterThan(0)
        expect(line.date >= s.inputs.period.start && line.date <= s.inputs.period.end, `${s.id} ${line.date} in period`).toBe(true)
        const rule = rules.get(line.rule)
        expect(rule, `${s.id} ${line.rule} names a rule`).toBeDefined()
        if (rule?.validFrom) expect(line.date >= rule.validFrom, `${s.id} ${line.rule} valid from`).toBe(true)
        if (rule?.validTo) expect(line.date <= rule.validTo, `${s.id} ${line.rule} valid to`).toBe(true)
        sum = roundOre(sum + line.amount)
      }
      expect(s.expected.total, s.id).toBe(sum)
    }
  })

  it('keeps the todo sick top-up data internally consistent', () => {
    for (const s of AGREEMENT_SCENARIOS) {
      if (s.kind !== 'sick-topup') continue
      const e = s.expected
      expect(roundOre(e.deductionPerDay + e.topUpPerDay), s.id).toBe(e.fullCalendarDay)
      expect(e.deductionPerDay, s.id).toBeLessThanOrEqual(e.fullCalendarDay)
      expect(e.totalDeduction, s.id).toBe(roundOre(e.days * e.deductionPerDay))
      expect(e.totalTopUp, s.id).toBe(roundOre(e.days * e.topUpPerDay))
    }
  })

  it('keeps the todo true-up data internally consistent', () => {
    for (const s of LIABILITY_SCENARIOS) {
      if (s.kind !== 'true-up') continue
      expect(s.expected.entry2920, s.id).toBe(roundOre(s.expected.target2920 - s.inputs.booked2920))
      expect(s.expected.entry2940, s.id).toBe(roundOre(s.expected.target2940 - s.inputs.booked2940))
    }
  })
})
