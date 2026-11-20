import { describe, expect, it } from 'vitest'
import { pickSpotCheck, spotCheckAmount, SPOT_CHECK_SIZE, type SpotCheckSource } from '../spot-check'

const op = (id: string, extra: Partial<SpotCheckSource> = {}): SpotCheckSource => ({ id, risk_level: 'low', ...extra })
const noWarning = () => false

describe('spotCheckAmount', () => {
  it('reads the first money field of the preview, then of the params, as an absolute value', () => {
    expect(spotCheckAmount(op('a', { preview_data: { count: 3, amount: -449 } }))).toBe(449)
    expect(spotCheckAmount(op('b', { preview_data: { title: 'x' }, params: { total_amount: 1200.5 } }))).toBe(1200.5)
  })

  it('is null when no amount is named, and never reads a count or a text as money', () => {
    expect(spotCheckAmount(op('a'))).toBeNull()
    expect(spotCheckAmount(op('b', { preview_data: { count: 12, amount: '449' } }))).toBeNull()
  })
})

describe('pickSpotCheck', () => {
  it('picks nothing from nothing', () => {
    expect(pickSpotCheck([], noWarning)).toEqual([])
  })

  it('one proposal is the whole sample', () => {
    const picked = pickSpotCheck([op('only')], noWarning)
    expect(picked.map((p) => [p.op.id, p.reason])).toEqual([['only', 'random']])
  })

  it('leads with a warning, the largest amount and a raised risk, then fills at random', () => {
    const ops = [
      op('plain-1'),
      op('big', { preview_data: { amount: -24116 } }),
      op('small', { preview_data: { amount: 250 } }),
      op('warned'),
      op('medium', { risk_level: 'medium' }),
      op('plain-2'),
    ]
    const picked = pickSpotCheck(ops, (o) => o.id === 'warned')
    expect(picked).toHaveLength(SPOT_CHECK_SIZE)
    expect(picked.slice(0, 3).map((p) => [p.op.id, p.reason])).toEqual([
      ['warned', 'warning'],
      ['big', 'largest'],
      ['medium', 'raised_risk'],
    ])
    expect(picked[3].reason).toBe('random')
    expect(new Set(picked.map((p) => p.op.id)).size).toBe(SPOT_CHECK_SIZE)
  })

  it('never picks a proposal twice when one fills several reasons', () => {
    const ops = [op('a', { risk_level: 'medium', preview_data: { amount: 900 } }), op('b'), op('c')]
    const picked = pickSpotCheck(ops, (o) => o.id === 'a')
    expect(picked.map((p) => p.op.id).sort()).toEqual(['a', 'b', 'c'])
    expect(picked[0]).toEqual({ op: ops[0], reason: 'warning' })
  })

  it('gives the same sample for the same proposals in any order', () => {
    const ops = Array.from({ length: 30 }, (_, i) => op(`op-${i}`))
    const first = pickSpotCheck(ops, noWarning).map((p) => p.op.id)
    const second = pickSpotCheck([...ops].reverse(), noWarning).map((p) => p.op.id)
    expect(first).toHaveLength(SPOT_CHECK_SIZE)
    expect(second).toEqual(first)
  })

  it('honours a smaller size', () => {
    expect(pickSpotCheck([op('a'), op('b'), op('c')], noWarning, 2)).toHaveLength(2)
  })
})
