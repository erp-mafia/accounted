/**
 * The grant door around the staging tools (../grant-door.ts): which calls it
 * looks at, what it hands applyCompanyGrant, and what the agent is told. The
 * enforcement itself is lib/grants (unit) and tests/pg/company-grants.pg.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const applyMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/grants/enforce', () => ({
  applyCompanyGrant: (...args: unknown[]) => applyMock(...args),
}))

import { applyGrantDoor, isGrantableCall, withGrantOutcome } from '../grant-door'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never
const KEY = '44444444-4444-4444-8444-444444444444'
const actor = { type: 'api_key', id: KEY, label: 'Claude', unattendedCommitLimit: 500, oauthKey: false, serviceAccountId: null }
const staged = {
  staged: true,
  operation_id: 'op-1',
  risk_level: 'medium',
  actor,
  message: 'Staged as pending_operation op-1 (risk: medium).',
  approve: { tool: 'gnubok_approve_pending_operation', args: { operation_id: 'op-1' } },
  preview: { amount: 149 },
}
const GRANT = { grant_id: 'g-1', grant_version: 2, use_id: 'u-1', amount_sek: 149, counterparty_label: 'Spotify AB', accepted_at: null }

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    toolName: 'gnubok_categorize_transaction',
    toolArgs: { transaction_id: 't-1', category: 'expense_software' },
    supabase: {} as never,
    companyId: 'company-1',
    userId: 'user-1',
    actor,
    log,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GRANT_SUGGESTIONS', 'true')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isGrantableCall', () => {
  it('covers categorize, directly or through the stage bridge, in either namespace, and nothing else', () => {
    expect(isGrantableCall('gnubok_categorize_transaction', {})).toBe(true)
    expect(isGrantableCall('gnubok_stage_tool', { tool: 'accounted_categorize_transaction' })).toBe(true)
    expect(isGrantableCall('gnubok_stage_tool', { tool: 'gnubok_create_voucher' })).toBe(false)
    expect(isGrantableCall('gnubok_create_voucher', {})).toBe(false)
    expect(isGrantableCall('gnubok_bulk_book_transactions', {})).toBe(false)
  })
})

describe('applyGrantDoor', () => {
  it('with GRANT_SUGGESTIONS off (the master switch) never attempts the claim', async () => {
    for (const value of [undefined, '', 'false', '0']) {
      if (value === undefined) vi.unstubAllEnvs()
      else vi.stubEnv('GRANT_SUGGESTIONS', value)
      expect(await applyGrantDoor(staged, ctx() as never)).toBe(staged)
    }
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('leaves every answer alone that is not a fresh staging by a key', async () => {
    for (const [result, context] of [
      [staged, ctx({ toolName: 'gnubok_create_voucher' })],
      [staged, ctx({ actor: { type: 'user' } })],
      [staged, ctx({ actor: { ...actor, id: undefined } })],
      [{ ...staged, dry_run: true, staged: false }, ctx()],
      [{ ...staged, idempotency_replay: true }, ctx()],
      [{ ...staged, operation_id: undefined }, ctx()],
      ['text', ctx()],
    ] as const) {
      expect(await applyGrantDoor(result, context as never)).toBe(result)
    }
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('hands the staged operation and the validated key to applyCompanyGrant', async () => {
    applyMock.mockResolvedValue({ applied: false, reason: 'no_grant' })
    expect(await applyGrantDoor(staged, ctx() as never)).toBe(staged)
    expect(applyMock).toHaveBeenCalledWith({}, {
      companyId: 'company-1',
      userId: 'user-1',
      operationId: 'op-1',
      credential: { actorType: 'api_key', apiKeyId: KEY, label: 'Claude', unattendedCommitLimit: 500 },
      log,
    })
  })

  it('names an OAuth connector key and a service account key as such', async () => {
    applyMock.mockResolvedValue({ applied: false, reason: 'no_grant' })
    await applyGrantDoor(staged, ctx({ actor: { ...actor, oauthKey: true } }) as never)
    await applyGrantDoor(staged, ctx({ actor: { ...actor, serviceAccountId: 'sa-1' } }) as never)
    expect(applyMock.mock.calls.map((c) => c[1].credential.actorType)).toEqual(['mcp_oauth', 'service_account'])
  })

  it('answers the staged result unchanged when the door itself fails', async () => {
    applyMock.mockRejectedValue(new Error('boom'))
    expect(await applyGrantDoor(staged, ctx() as never)).toBe(staged)
  })
})

describe('withGrantOutcome', () => {
  it('says nothing about grants when none was in play', () => {
    for (const reason of ['switched_off', 'no_grant', 'no_grant_for_counterparty', 'unknown_counterparty', 'not_in_database']) {
      expect(withGrantOutcome(staged, { applied: false, reason })).toBe(staged)
    }
  })

  it('tells the agent why a rule for the counterparty did not apply, keeping the approval hint', () => {
    const result = withGrantOutcome(staged, { applied: false, reason: 'above_limit', detail: { grant_id: 'g-1', amount_sek: 999, limit_sek: 200 } })
    expect(result).toMatchObject({
      approve: staged.approve,
      grant: { applied: false, reason: 'above_limit', grant_id: 'g-1', amount_sek: 999, limit_sek: 200 },
      message: expect.stringContaining("the amount is above the rule's limit"),
    })
  })

  it('reports a booking under a rule as committed, with nothing left to approve', () => {
    const result = withGrantOutcome(staged, {
      applied: true,
      committed: true,
      grant: GRANT,
      journalEntryId: 'je-1',
      patternVerified: true,
      result: { status: 'committed' },
    })
    expect(result).not.toHaveProperty('approve')
    expect(result).toMatchObject({
      staged: true,
      operation_status: 'committed',
      grant: { applied: true, status: 'committed', grant_id: 'g-1', grant_version: 2, amount_sek: 149, journal_entry_id: 'je-1' },
      message: expect.stringContaining('Bokfört enligt regel'),
    })
  })

  it('reports a refused commit under a rule, keeping the approval hint only while the operation is still pending', () => {
    const pending = withGrantOutcome(staged, {
      applied: true,
      committed: false,
      grant: GRANT,
      result: { status: 'failed', code: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED', operation_status: 'pending' },
    })
    expect(pending).toMatchObject({ approve: staged.approve, operation_status: 'pending', grant: { status: 'refused', error_code: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED' } })
    const rejected = withGrantOutcome(staged, {
      applied: true,
      committed: false,
      grant: GRANT,
      result: { status: 'rejected', code: 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE', error: 'Möjlig dubblett', operation_status: 'rejected' },
    })
    expect(rejected).not.toHaveProperty('approve')
    expect(rejected).toMatchObject({ operation_status: 'rejected', grant: { status: 'refused', error: 'Möjlig dubblett' } })
  })
})
