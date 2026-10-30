import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as decideModule from '../decide'
import { DOOR_SPECS, OUTSIDE, type DoorClass } from '../doors'
import {
  DEDUPE_WINDOW_MS,
  resetPermissionShadowForTests,
  sessionShadow,
  shadowPermission,
  todayFromToolFailure,
  type ShadowObservation,
} from '../shadow'
import { insertShadowRow } from '../shadow-writer'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const KEY = '33333333-3333-4333-8333-333333333333'
const IDENTITY = '44444444-4444-4444-8444-444444444444'

const BOOK: DoorClass = { ...DOOR_SPECS.BOOK, stageable: true }
const SETTINGS: DoorClass = { ...DOOR_SPECS.SETTINGS, stageable: false }

/** Let after()'s fallback (a microtask outside a request scope) and its awaits run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function personObs(overrides: Partial<ShadowObservation> = {}): ShadowObservation {
  return {
    door: 'session:test.route',
    method: 'POST',
    doorRule: BOOK,
    companyId: COMPANY,
    principal: { kind: 'person', userId: USER },
    role: 'member',
    today: { outcome: 'allow' },
    ...overrides,
  }
}

function agentObs(overrides: Partial<ShadowObservation> = {}): ShadowObservation {
  return {
    door: 'mcp:gnubok_create_voucher',
    method: null,
    doorRule: BOOK,
    companyId: COMPANY,
    principal: {
      kind: 'agent',
      userId: USER,
      key: { kind: 'oauth', scopes: ['bookkeeping:write'], apiKeyId: KEY, agentIdentityId: IDENTITY },
    },
    role: 'owner',
    today: { outcome: 'stage' },
    ...overrides,
  }
}

describe('permission shadow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPermissionShadowForTests()
    delete process.env.PERMISSIONS_SHADOW
  })
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.PERMISSIONS_SHADOW
  })

  it('writes nothing when decide() agrees with today', async () => {
    shadowPermission(personObs({ role: 'member', today: { outcome: 'allow' } }))
    shadowPermission(personObs({ role: 'viewer', today: { outcome: 'deny', code: 'WRITE_REQUIRED', by: 'gate' } }))
    // An OAuth key without approve stages, as decide() would have it.
    shadowPermission(agentObs())
    // A dry run that decide() would stage wrote nothing either way.
    shadowPermission(agentObs({ today: { outcome: 'allow', dryRun: true } }))
    await flush()
    expect(insertShadowRow).not.toHaveBeenCalled()
  })

  it('writes one row of ids and codes for a disagreement, after the response', async () => {
    // A member passes a gate that decide() would refuse (settings is an owner's or admin's).
    shadowPermission(personObs({ doorRule: SETTINGS, today: { outcome: 'allow' } }))
    expect(insertShadowRow).not.toHaveBeenCalled()
    await flush()
    expect(insertShadowRow).toHaveBeenCalledTimes(1)
    expect(vi.mocked(insertShadowRow).mock.calls[0]![0]).toEqual({
      company_id: COMPANY,
      user_id: USER,
      agent_identity_id: null,
      api_key_id: null,
      principal_kind: 'person',
      door: 'session:test.route',
      method: 'POST',
      today_outcome: 'allow',
      today_code: null,
      decide_outcome: 'deny',
      decide_reason: 'PERMISSION_MISSING',
      permission: 'settings',
      expected: false,
      expected_reason: null,
    })
  })

  it("logs an agent's disagreement with its key and identity", async () => {
    // An OAuth key that committed where decide() would stage.
    shadowPermission(agentObs({ today: { outcome: 'allow' } }))
    await flush()
    expect(insertShadowRow).toHaveBeenCalledWith(
      expect.objectContaining({
        principal_kind: 'agent',
        api_key_id: KEY,
        agent_identity_id: IDENTITY,
        today_outcome: 'allow',
        decide_outcome: 'stage',
        decide_reason: 'PROPOSE_STAGES',
        expected: false,
      }),
    )
  })

  it('marks the differences the plan intends as expected', async () => {
    // A documented preset exception: a viewer passes an ungated route today.
    shadowPermission(
      personObs({
        role: 'viewer',
        doorRule: { ...DOOR_SPECS.BOOK_RECORD, stageable: false },
        request: { method: 'POST', pathname: '/api/parties/aliases' },
      }),
    )
    // An agent never holds settings.
    shadowPermission(
      agentObs({
        door: 'v1:settings.update',
        doorRule: SETTINGS,
        principal: { kind: 'agent', userId: USER, key: { kind: 'manual', scopes: ['companies:write'], apiKeyId: KEY, agentIdentityId: null } },
        today: { outcome: 'allow' },
      }),
    )
    // The gate passed and the handler refused (a colleague's key): the finer check stays.
    shadowPermission(
      personObs({
        door: 'session:api_keys.revoke',
        doorRule: { ...DOOR_SPECS.CONNECT, stageable: false },
        today: { outcome: 'deny', code: 'HANDLER_FORBIDDEN', by: 'handler' },
      }),
    )
    await flush()
    const rows = vi.mocked(insertShadowRow).mock.calls.map(([row]) => [row.door, row.expected, row.expected_reason])
    expect(rows).toEqual([
      ['session:test.route', true, 'VIEWER_PASSES_UNGATED_ROUTE'],
      ['v1:settings.update', true, 'AGENT_NEVER_HOLDS'],
      ['session:api_keys.revoke', true, 'HANDLER_CHECK'],
    ])
  })

  it('does nothing with PERMISSIONS_SHADOW=off', async () => {
    process.env.PERMISSIONS_SHADOW = 'off'
    const spy = vi.spyOn(decideModule, 'decide')
    shadowPermission(personObs({ doorRule: SETTINGS }))
    const record = sessionShadow({
      door: 'session:x',
      method: 'POST',
      pathname: '/api/settings',
      companyId: COMPANY,
      userId: USER,
      role: 'member',
    })
    record({ outcome: 'allow' })
    await flush()
    expect(spy).not.toHaveBeenCalled()
    expect(insertShadowRow).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('writes one row per door, principal, reason and outcome per window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let i = 0; i < 5; i++) shadowPermission(personObs({ doorRule: SETTINGS }))
    await flush()
    expect(insertShadowRow).toHaveBeenCalledTimes(1)

    // Another principal is its own row.
    shadowPermission(personObs({ doorRule: SETTINGS, principal: { kind: 'person', userId: KEY } }))
    await flush()
    expect(insertShadowRow).toHaveBeenCalledTimes(2)

    // After the window the same disagreement is logged again.
    vi.setSystemTime(Date.now() + DEDUPE_WINDOW_MS + 1)
    shadowPermission(personObs({ doorRule: SETTINGS }))
    await flush()
    expect(insertShadowRow).toHaveBeenCalledTimes(3)
  })

  it('swallows every failure: a throwing decide(), door thunk or writer never reaches the caller', async () => {
    const spy = vi.spyOn(decideModule, 'decide').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => shadowPermission(personObs({ doorRule: SETTINGS }))).not.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
    await flush()
    expect(insertShadowRow).not.toHaveBeenCalled()

    expect(() =>
      shadowPermission(
        personObs({
          doorRule: () => {
            throw new Error('door boom')
          },
        }),
      ),
    ).not.toThrow()

    vi.mocked(insertShadowRow).mockRejectedValueOnce(new Error('db down'))
    expect(() => shadowPermission(personObs({ doorRule: SETTINGS }))).not.toThrow()
    await flush()
    expect(insertShadowRow).toHaveBeenCalledTimes(1)
  })

  it('skips doors no permission governs, a missing company and an unknown person role', async () => {
    shadowPermission(personObs({ doorRule: OUTSIDE.approval, today: { outcome: 'deny' } }))
    shadowPermission(personObs({ doorRule: null, today: { outcome: 'deny' } }))
    shadowPermission(personObs({ companyId: null, doorRule: SETTINGS }))
    shadowPermission(personObs({ role: undefined, doorRule: SETTINGS }))
    await flush()
    expect(insertShadowRow).not.toHaveBeenCalled()
  })

  it('never reads the role itself: a request whose door did not read it is skipped', async () => {
    shadowPermission(agentObs({ role: undefined, today: { outcome: 'deny', code: 'ROLE_READ_ONLY', by: 'gate' } }))
    shadowPermission(agentObs({ role: undefined, today: { outcome: 'allow' } }))
    shadowPermission(agentObs({ role: null, today: { outcome: 'allow' } }))
    await flush()
    expect(insertShadowRow).not.toHaveBeenCalled()
  })

  it('reads a tool failure as a handler refusal only when its code answers 403', () => {
    expect(todayFromToolFailure(Object.assign(new Error('x'), { code: 'FORBIDDEN' }), true)).toEqual({
      outcome: 'deny',
      code: 'FORBIDDEN',
      by: 'handler',
    })
    expect(todayFromToolFailure(Object.assign(new Error('x'), { code: 'VALIDATION_ERROR' }), true)).toEqual({ outcome: 'stage' })
    expect(todayFromToolFailure(new Error('plain'), false)).toEqual({ outcome: 'allow' })
  })

  it('records a session request once, writes only, and only with a known role', async () => {
    const base = { door: 'session:x', pathname: '/api/settings', companyId: COMPANY, userId: USER }
    const record = sessionShadow({ ...base, method: 'PUT', role: 'member' })
    record({ outcome: 'allow' })
    record({ outcome: 'allow' })
    sessionShadow({ ...base, method: 'GET', role: 'member' })({ outcome: 'allow' })
    sessionShadow({ ...base, method: 'PUT', role: undefined })({ outcome: 'allow' })
    await flush()
    expect(insertShadowRow).toHaveBeenCalledTimes(1)
    expect(insertShadowRow).toHaveBeenCalledWith(
      expect.objectContaining({ door: 'session:x', method: 'PUT', decide_reason: 'PERMISSION_MISSING', permission: 'settings' }),
    )
  })
})
