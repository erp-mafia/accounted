import { describe, expect, it } from 'vitest'
import { REJECT_OWN_SCOPES, STAGING_SCOPES } from '@/lib/auth/scope-catalog'
import { canRejectOperation, isStagedByKey, rejectAuthority } from '../reject-authority'

const KEY = 'a1a1a1a1-0000-4000-8000-000000000001'
const OTHER_KEY = 'b2b2b2b2-0000-4000-8000-000000000002'

describe('rejectAuthority', () => {
  it('approve rejects anything, whatever else the key holds', () => {
    expect(rejectAuthority(['pending_operations:approve'])).toBe('any')
    expect(rejectAuthority(['pending_operations:read', 'pending_operations:approve', 'invoices:write'])).toBe('any')
  })

  it('every scope a tool stages through gives "own" on its own', () => {
    for (const scope of REJECT_OWN_SCOPES) {
      expect(rejectAuthority(['pending_operations:read', scope]), scope).toBe('own')
    }
    for (const scope of STAGING_SCOPES) expect(REJECT_OWN_SCOPES, scope).toContain(scope)
  })

  it('agent:write gives "own": gnubok_propose_fact stages fact proposals under it', () => {
    expect(rejectAuthority(['agent:read', 'agent:write'])).toBe('own')
  })

  it('read scopes and elevated scopes no tool stages through give nothing', () => {
    expect(rejectAuthority([])).toBe('none')
    expect(rejectAuthority(['pending_operations:read', 'reports:read', 'transactions:read'])).toBe('none')
    // webhooks:manage cannot stage a proposal.
    expect(rejectAuthority(['reports:read', 'webhooks:manage'])).toBe('none')
  })
})

describe('isStagedByKey', () => {
  it('matches only an api_key row carrying this key id', () => {
    expect(isStagedByKey({ actor_type: 'api_key', actor_id: KEY }, KEY)).toBe(true)
    expect(isStagedByKey({ actor_type: 'api_key', actor_id: OTHER_KEY }, KEY)).toBe(false)
    // A proposal made in the app is never the key's, even if the ids collide.
    expect(isStagedByKey({ actor_type: 'user', actor_id: KEY }, KEY)).toBe(false)
    expect(isStagedByKey({ actor_type: 'cron', actor_id: KEY }, KEY)).toBe(false)
  })

  it('never matches without both ids', () => {
    expect(isStagedByKey({ actor_type: 'api_key', actor_id: null }, KEY)).toBe(false)
    expect(isStagedByKey({ actor_type: 'api_key', actor_id: KEY }, undefined)).toBe(false)
    expect(isStagedByKey({ actor_type: 'api_key', actor_id: null }, null)).toBe(false)
    expect(isStagedByKey({ actor_type: 'api_key', actor_id: '' }, '')).toBe(false)
  })
})

describe('canRejectOperation', () => {
  const own = { actor_type: 'api_key', actor_id: KEY }
  const otherConnection = { actor_type: 'api_key', actor_id: OTHER_KEY }
  const person = { actor_type: 'user', actor_id: null }

  it('"any" rejects every operation', () => {
    for (const op of [own, otherConnection, person]) expect(canRejectOperation('any', KEY, op)).toBe(true)
  })

  it('"own" rejects only what this key staged', () => {
    expect(canRejectOperation('own', KEY, own)).toBe(true)
    expect(canRejectOperation('own', KEY, otherConnection)).toBe(false)
    expect(canRejectOperation('own', KEY, person)).toBe(false)
  })

  it('"none" rejects nothing, not even an own-looking row', () => {
    for (const op of [own, otherConnection, person]) expect(canRejectOperation('none', KEY, op)).toBe(false)
  })
})
