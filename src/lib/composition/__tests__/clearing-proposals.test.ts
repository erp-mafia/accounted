/**
 * The clearing proposer list is static: a change to who proposes, in which
 * order, is a change to this test. What each proposer does is pinned beside
 * it (lib/pos-sales/__tests__/payout-proposals.test.ts).
 */
import { describe, expect, it } from 'vitest'
import { MODULE_IDS } from '@/lib/modules/manifest'
import { CLEARING_PROPOSERS } from '../clearing-proposals'

describe('CLEARING_PROPOSERS', () => {
  it('asks the till, owned by its block', () => {
    expect(CLEARING_PROPOSERS.map((p) => ({ id: p.id, module: p.module }))).toEqual([{ id: 'pos-payouts', module: 'pos' }])
  })

  it('is frozen, with unique ids and known modules', () => {
    expect(Object.isFrozen(CLEARING_PROPOSERS)).toBe(true)
    expect(new Set(CLEARING_PROPOSERS.map((p) => p.id)).size).toBe(CLEARING_PROPOSERS.length)
    for (const p of CLEARING_PROPOSERS) expect(MODULE_IDS).toContain(p.module)
  })
})
