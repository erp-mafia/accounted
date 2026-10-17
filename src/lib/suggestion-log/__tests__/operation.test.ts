import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
import type { PendingOperation } from '@/types'

const logSpy = vi.hoisted(() => {
  const spy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: (): unknown => spy }
  return spy
})
vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger')>()),
  createLogger: () => logSpy,
}))

import {
  approvalPolicy,
  buildOperationDecisionRows,
  entryIdsNamedIn,
  recordOperationDecision,
  type OperationDecision,
} from '../operation'
import { operationInputHash } from '../provenance'
import { buildDecisionReceipt, DecisionReceiptSchema, type SuggestionLogRow } from '../receipts'

const COMPANY = 'company-1'
const USER = 'user-1'
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const ENTRY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ORIGINAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CLAIMED_AT = '2026-10-16T10:00:00.000+00:00'
const BEFORE_CLAIM = '2026-10-01T09:00:00.000+00:00'
const AFTER_CLAIM = '2026-10-16T10:00:00.250+00:00'

const operation: OperationDecision['operation'] = {
  id: OPERATION_ID,
  operation_type: 'set_opening_balances_manual',
  params: { lines: [{ account_number: '1930', amount: 10000 }, { account_number: '2081', amount: -10000 }] },
  preview_data: { journal_entry: { total_debit: 10000 } },
  risk_level: 'high',
  agent_metadata: { model: 'claude-test' },
} as Pick<PendingOperation, 'id' | 'operation_type' | 'params' | 'preview_data' | 'risk_level' | 'agent_metadata'>

const person: CommitActor = { type: 'user', label: 'anna@example.se' }
const serviceAccount: CommitActor = { type: 'service_account', label: 'Attestharness', unattendedCommitLimit: 5000 }

function decision(overrides: Partial<OperationDecision> = {}): OperationDecision {
  return {
    companyId: COMPANY,
    userId: USER,
    operation,
    resultData: { journal_entry_id: ENTRY },
    claimedAt: CLAIMED_AT,
    actor: person,
    ...overrides,
  }
}

/**
 * journal_entries and suggestion_log behind the three query shapes the
 * writer uses: posted vouchers by id and committed_at, the rows already
 * recorded for an operation, and the insert.
 */
function fakeDb(
  opts: {
    entries?: Array<{ id: string; committed_at: string | null }>
    rows?: Array<Record<string, unknown>>
    selectError?: string
    insertError?: string
  } = {},
) {
  const entries = opts.entries ?? [{ id: ENTRY, committed_at: AFTER_CLAIM }]
  const rows = opts.rows ?? []
  const queries: string[] = []
  const client = {
    from(table: string) {
      const eqs = new Map<string, unknown>()
      let ins: string[] | null = null
      let gte: string | null = null
      const answer = () => {
        if (opts.selectError) return { data: null, error: { message: opts.selectError } }
        if (table === 'journal_entries') {
          const data = entries
            .filter((e) => eqs.get('company_id') === COMPANY && (ins ?? []).includes(e.id))
            .filter((e) => e.committed_at !== null && gte !== null && e.committed_at >= gte)
            .map((e) => ({ id: e.id }))
          return { data, error: null }
        }
        const data = rows
          .filter((r) => r.company_id === eqs.get('company_id') && r.pending_operation_id === eqs.get('pending_operation_id'))
          .filter((r) => !eqs.has('kind') || r.kind === eqs.get('kind'))
          .map((r) => ({ id: r.id, journal_entry_id: (r.final as { journal_entry_id?: string } | null)?.journal_entry_id ?? null }))
        return { data, error: null }
      }
      const builder = {
        select: () => {
          queries.push(`select ${table}`)
          return builder
        },
        eq: (column: string, value: unknown) => {
          eqs.set(column, value)
          return builder
        },
        in: (_column: string, values: string[]) => {
          ins = values
          return builder
        },
        gte: (_column: string, value: string) => {
          gte = value
          return builder
        },
        order: () => builder,
        range: () => builder,
        then: (resolve: (value: unknown) => void) => resolve(answer()),
        insert: async (inserted: Array<Record<string, unknown>>) => {
          queries.push(`insert ${table}`)
          if (opts.insertError) return { error: { message: opts.insertError } }
          for (const row of inserted) rows.push({ id: `row-${rows.length + 1}`, ...row })
          return { error: null }
        },
      }
      return builder
    },
  }
  return { client: client as never, rows, queries }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('entryIdsNamedIn', () => {
  it('reads voucher ids under any key ending in entry_id or entry_ids, nested lists included, in order', () => {
    expect(
      entryIdsNamedIn({
        journal_entry_id: ENTRY,
        storno_entry_id: ENTRY_2.toUpperCase(),
        results: [{ journal_entry_id: ORIGINAL }, { journal_entry_id: ENTRY }],
        journal_entry_ids: [ENTRY_2],
        transaction_id: '99999999-9999-4999-8999-999999999999',
        invoice_id: '88888888-8888-4888-8888-888888888888',
        entry_note: 'not an id',
        reentry_id: 'also-not-a-uuid',
      }),
    ).toEqual([ENTRY, ENTRY_2, ORIGINAL])
  })

  it('answers nothing for a result that names no voucher', () => {
    expect(entryIdsNamedIn({ customer_id: ENTRY })).toEqual([])
    expect(entryIdsNamedIn(null)).toEqual([])
    expect(entryIdsNamedIn(undefined)).toEqual([])
  })
})

describe('approvalPolicy', () => {
  it('records a person approving the staged proposal as review', () => {
    expect(approvalPolicy(person)).toEqual({ policyVersion: 'staged-approval.1;approver=person', band: 'review' })
  })

  it('records a key credential as direct, under its unattended ceiling', () => {
    expect(approvalPolicy(serviceAccount)).toEqual({
      policyVersion: 'staged-approval.1;approver=credential;unattended_limit=5000',
      band: 'direct',
    })
    for (const type of ['api_key', 'mcp_oauth'] as const) {
      expect(approvalPolicy({ type, unattendedCommitLimit: null })).toEqual({
        policyVersion: 'staged-approval.1;approver=credential;unattended_limit=none',
        band: 'direct',
      })
    }
    expect(approvalPolicy({ type: 'api_key', unattendedCommitLimit: 0 }).policyVersion).toMatch(/unattended_limit=none$/)
  })

  it('records a company grant as the policy, band direct, when a key committed under it', () => {
    const grant = { grantId: '44444444-4444-4444-8444-444444444444', grantVersion: 2 }
    expect(approvalPolicy({ type: 'api_key', label: 'Claude', unattendedCommitLimit: 500 }, grant)).toEqual({
      policyVersion: 'grant.1;grant_id=44444444-4444-4444-8444-444444444444;grant_version=2',
      band: 'direct',
    })
    // A person approving is the person's decision, whatever is passed along.
    expect(approvalPolicy(person, grant)).toEqual({ policyVersion: 'staged-approval.1;approver=person', band: 'review' })
  })

  it('records no policy for an approver it cannot classify: never a policy without its band', () => {
    expect(approvalPolicy(undefined)).toEqual({ policyVersion: null, band: null })
    expect(approvalPolicy({ type: 'cron' })).toEqual({ policyVersion: null, band: null })
  })
})

describe('recordOperationDecision', () => {
  it('records an approval by a person: one accepted receipt naming the operation, the approver, the policy and the approved preview', async () => {
    const db = fakeDb()
    await expect(recordOperationDecision(db.client, decision())).resolves.toBe(1)
    expect(db.rows).toEqual([
      {
        id: 'row-1',
        company_id: COMPANY,
        kind: 'operation',
        pending_operation_id: OPERATION_ID,
        suggestions: [
          {
            source: 'pending_operation',
            source_id: OPERATION_ID,
            rank: 0,
            proposal: { operation_type: 'set_opening_balances_manual', risk_level: 'high' },
            confidence: null,
            model: 'claude-test',
            prompt_sha256: null,
            matches_final: true,
          },
        ],
        acted_on: 0,
        final: { journal_entry_id: ENTRY, operation_type: 'set_opening_balances_manual', journal_entry_ids: [ENTRY] },
        outcome: 'accepted',
        actor_type: 'user',
        resolved_by: USER,
        rule_version: null,
        policy_version: 'staged-approval.1;approver=person',
        confidence_band: 'review',
        input_hash: operationInputHash({
          operationType: operation.operation_type,
          params: operation.params,
          preview: operation.preview_data,
        }),
        checks: null,
      },
    ])
    expect(db.rows[0]!.input_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(logSpy.error).not.toHaveBeenCalled()
  })

  it('records an approval by a service account key as direct, with the key as the deciding actor', async () => {
    const db = fakeDb()
    await recordOperationDecision(db.client, decision({ actor: serviceAccount }))
    expect(db.rows[0]).toMatchObject({
      actor_type: 'service_account',
      resolved_by: USER,
      policy_version: 'staged-approval.1;approver=credential;unattended_limit=5000',
      confidence_band: 'direct',
    })
  })

  it('writes one receipt per voucher the approval posted, and none for a voucher it only refers to', async () => {
    const db = fakeDb({
      entries: [
        { id: ENTRY, committed_at: AFTER_CLAIM },
        { id: ENTRY_2, committed_at: CLAIMED_AT },
        // The original a storno reverses: posted long before the claim.
        { id: ORIGINAL, committed_at: BEFORE_CLAIM },
      ],
    })
    const written = await recordOperationDecision(
      db.client,
      decision({ resultData: { storno_entry_id: ENTRY, corrected_entry_id: ENTRY_2, original_entry_id: ORIGINAL } }),
    )
    expect(written).toBe(2)
    expect(db.rows.map((r) => (r.final as { journal_entry_id: string }).journal_entry_id)).toEqual([ENTRY, ENTRY_2])
    for (const row of db.rows) expect((row.final as { journal_entry_ids: string[] }).journal_entry_ids).toEqual([ENTRY, ENTRY_2])
  })

  it('leaves a voucher to the door that already recorded its decision for the same operation', async () => {
    const db = fakeDb({
      entries: [
        { id: ENTRY, committed_at: AFTER_CLAIM },
        { id: ENTRY_2, committed_at: AFTER_CLAIM },
      ],
      rows: [{ id: 'door-row', company_id: COMPANY, kind: 'bank_line', pending_operation_id: OPERATION_ID, final: { journal_entry_id: ENTRY } }],
    })
    await expect(recordOperationDecision(db.client, decision({ resultData: { journal_entry_ids: [ENTRY, ENTRY_2] } }))).resolves.toBe(1)
    expect(db.rows.map((r) => [r.kind, (r.final as { journal_entry_id: string }).journal_entry_id])).toEqual([
      ['bank_line', ENTRY],
      ['operation', ENTRY_2],
    ])
  })

  it('under a grant, writes its operation row beside the door row, naming the grant, once', async () => {
    const grant = { grantId: '44444444-4444-4444-8444-444444444444', grantVersion: 1 }
    const db = fakeDb({
      rows: [{ id: 'door-row', company_id: COMPANY, kind: 'bank_line', pending_operation_id: OPERATION_ID, final: { journal_entry_id: ENTRY } }],
    })
    const underGrant = decision({ actor: { type: 'api_key', label: 'Claude', unattendedCommitLimit: null }, grant })
    await expect(recordOperationDecision(db.client, underGrant)).resolves.toBe(1)
    expect(db.rows.map((r) => [r.kind, r.policy_version, r.confidence_band])).toEqual([
      ['bank_line', undefined, undefined],
      ['operation', 'grant.1;grant_id=44444444-4444-4444-8444-444444444444;grant_version=1', 'direct'],
    ])
    await expect(recordOperationDecision(db.client, underGrant)).resolves.toBe(0)
  })

  it('is idempotent: recording the same approval again writes nothing', async () => {
    const db = fakeDb()
    await expect(recordOperationDecision(db.client, decision())).resolves.toBe(1)
    await expect(recordOperationDecision(db.client, decision())).resolves.toBe(0)
    expect(db.rows).toHaveLength(1)
    expect(db.queries.filter((q) => q === 'insert suggestion_log')).toHaveLength(1)
  })

  it('never throws: a failed insert is logged and dropped', async () => {
    const db = fakeDb({ insertError: 'permission denied for table suggestion_log' })
    await expect(recordOperationDecision(db.client, decision())).resolves.toBe(0)
    expect(logSpy.error).toHaveBeenCalledWith(
      'failed to record the staged operation decision (commit unaffected)',
      expect.objectContaining({ pendingOperationId: OPERATION_ID, error: 'permission denied for table suggestion_log' }),
    )
  })

  it('never throws: a failed read is logged and dropped', async () => {
    const db = fakeDb({ selectError: 'canceling statement due to statement timeout' })
    await expect(recordOperationDecision(db.client, decision())).resolves.toBe(0)
    expect(logSpy.error).toHaveBeenCalledTimes(1)
    expect(db.rows).toEqual([])
  })

  it('reads nothing when the result names no voucher or the claim time is unknown', async () => {
    const db = fakeDb()
    await expect(recordOperationDecision(db.client, decision({ resultData: { customer_id: ENTRY } }))).resolves.toBe(0)
    await expect(recordOperationDecision(db.client, decision({ claimedAt: null }))).resolves.toBe(0)
    expect(db.queries).toEqual([])
  })
})

describe('an operation row read back as a receipt', () => {
  it('answers subject_kind operation, the staged proposal as the accepted candidate, no score, and the recorded policy', () => {
    const [row] = buildOperationDecisionRows(decision({ actor: serviceAccount }), [ENTRY], [ENTRY])
    const logged: SuggestionLogRow = {
      ...row!,
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      transaction_id: null,
      inbox_item_id: null,
      document_id: null,
      created_at: '2026-10-16T10:00:01Z',
    }
    const receipt = buildDecisionReceipt(logged, {
      entries: new Map([
        [ENTRY, { id: ENTRY, voucher_series: 'A', voucher_number: 1, status: 'posted', committed_actor_type: 'service_account', committed_actor_label: 'Attestharness', commit_method: 'api_key' }],
      ]),
      operations: new Map(),
      operationsById: new Map([
        [
          OPERATION_ID,
          {
            id: OPERATION_ID,
            operation_type: 'set_opening_balances_manual',
            actor_type: 'service_account',
            actor_id: 'key-1',
            actor_label: 'Attestharness',
            risk_level: 'high',
            agent_metadata: { model: 'claude-test' },
            created_at: '2026-10-16T09:59:00Z',
            resolved_at: '2026-10-16T10:00:01Z',
            journal_entry_id: ENTRY,
            registration_journal_entry_id: null,
          },
        ],
      ]),
    })
    expect(DecisionReceiptSchema.safeParse(receipt).success).toBe(true)
    expect(receipt).toMatchObject({
      subject_kind: 'operation',
      outcome: 'accepted',
      decided_by: { actor_type: 'service_account', user_id: USER, label: 'Attestharness', commit_method: 'api_key' },
      proposed_by: { pending_operation_id: OPERATION_ID, operation_type: 'set_opening_balances_manual', actor_type: 'service_account', model: 'claude-test' },
      chosen: { source: 'pending_operation', source_id: OPERATION_ID, accounts: [], matches_final: true },
      booked: { journal_entry_id: ENTRY, voucher: 'A1', entry_status: 'posted' },
      confidence: { value: null, basis: null },
      rule_version: null,
      policy_version: 'staged-approval.1;approver=credential;unattended_limit=5000',
      confidence_band: 'direct',
      checks: null,
    })
    expect(receipt.input_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
