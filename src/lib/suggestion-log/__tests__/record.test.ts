import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { accountProposal, type BookingProposal } from '@/lib/bookkeeping/proposal'
import { DIRECT_BOOKING_POLICY_VERSION } from '@/lib/transactions/direct-booking'
import { runInOperationCommit } from '@/lib/pending-operations/commit-scope'
import { finalFromCategorize, finalFromLines, recordDecisions, snapshotSuggestions, type SuggestionSnapshot } from '../record'
import { bankLineInputHash, sha256Hex } from '../provenance'
import { passed, warned } from '../checks'

const mockPropose = vi.fn()
vi.mock('@/lib/transactions/propose', () => ({
  BANK_PROPOSAL_RULES_REVISION: 'bank-proposals.1',
  proposeForTransactions: (...args: unknown[]) => mockPropose(...args),
}))
vi.mock('@/lib/company/entity-type', () => ({
  resolveCompanyEntityType: vi.fn(async () => 'aktiebolag'),
}))

const mockGetActor = vi.fn()
vi.mock('@/lib/bookkeeping/actor-context', () => ({
  getActor: () => mockGetActor(),
}))

const assistant = accountProposal({
  id: 'assistant:tx-1',
  source: 'assistant',
  account: '6540',
  label: 'IT-tjänster',
  category: 'expense_software',
  vat_treatment: 'standard_25',
  amount: -500,
  confidence: 0.8,
})

/**
 * The query shapes the module uses: a select of transactions, a select of
 * the pinned documents' hashes, an insert into suggestion_log.
 */
function fakeClient(
  opts: { transactions?: unknown[]; documents?: unknown[]; selectError?: string; documentError?: string; insertError?: string } = {},
) {
  const inserts: Array<{ table: string; rows: unknown }> = []
  const client = {
    from(table: string) {
      const error = table === 'document_attachments' ? opts.documentError : opts.selectError
      const data = table === 'document_attachments' ? (opts.documents ?? []) : (opts.transactions ?? [])
      return {
        select: () => ({
          eq: () => ({
            in: async () => (error ? { data: null, error: { message: error } } : { data, error: null }),
          }),
        }),
        insert: async (rows: unknown) => {
          inserts.push({ table, rows })
          return { error: opts.insertError ? { message: opts.insertError } : null }
        },
      }
    },
  }
  return { client, inserts }
}

const ownRule: BookingProposal = {
  ...accountProposal({
    id: 'rule:r1',
    source: 'rule',
    account: '5410',
    label: 'Förbrukningsinventarier',
    category: 'expense_equipment',
    vat_treatment: 'standard_25',
    amount: -500,
    confidence: 0.92,
  }),
  rule_own: true,
  rule_requires_review: false,
}

const tx = { id: 'tx-1', date: '2026-10-01', amount: -500, currency: 'SEK', description: 'Kjell & Co', merchant_name: 'Kjell & Co', document_id: 'doc-1' }
const read = {
  transaction_id: 'tx-1',
  model: 'm',
  prompt_sha256: 'h',
  agreement: 1,
  from_candidate: false,
  reasoning: 'Kvittot visar en kabel.',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetActor.mockReturnValue(undefined)
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '')
  vi.stubEnv('NEXT_PUBLIC_BUILD_ID', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('snapshotSuggestions', () => {
  it('keeps what was on offer per transaction, with the assistant read, the row document and the inputs hash', async () => {
    mockPropose.mockResolvedValue({ proposals: { 'tx-1': [assistant] }, assistant_reads: { 'tx-1': read } })
    const { client } = fakeClient({ transactions: [tx], documents: [{ id: 'doc-1', sha256_hash: 'd'.repeat(64) }] })

    const snapshot = await snapshotSuggestions(client as never, 'company-1', ['tx-1'])

    expect(snapshot.entityType).toBe('aktiebolag')
    expect(snapshot.ruleVersion).toBe('bank-proposals.1')
    expect(snapshot.byTransaction.get('tx-1')).toEqual({
      proposals: [assistant],
      read,
      documentId: 'doc-1',
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('pins the program version onto the rules version when the build knows it', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'a38016f12abcdef0123')
    mockPropose.mockResolvedValue({ proposals: {}, assistant_reads: {} })
    const { client } = fakeClient({ transactions: [{ ...tx, document_id: null }] })

    const snapshot = await snapshotSuggestions(client as never, 'company-1', ['tx-1'])

    expect(snapshot.ruleVersion).toBe('bank-proposals.1+a38016f12abc')
  })

  it("hashes the document's own bytes in: another document is another input", async () => {
    mockPropose.mockResolvedValue({ proposals: { 'tx-1': [assistant] }, assistant_reads: {} })
    const hashWith = async (sha: string) =>
      (await snapshotSuggestions(
        fakeClient({ transactions: [tx], documents: [{ id: 'doc-1', sha256_hash: sha }] }).client as never,
        'company-1',
        ['tx-1'],
      )).byTransaction.get('tx-1')?.inputHash

    expect(await hashWith('a'.repeat(64))).toBe(await hashWith('a'.repeat(64)))
    expect(await hashWith('a'.repeat(64))).not.toBe(await hashWith('b'.repeat(64)))
  })

  it('keeps the suggestions but records no inputs hash when the document hash cannot be read', async () => {
    mockPropose.mockResolvedValue({ proposals: { 'tx-1': [assistant] }, assistant_reads: {} })
    const { client } = fakeClient({ transactions: [tx], documentError: 'timeout' })

    const snapshot = await snapshotSuggestions(client as never, 'company-1', ['tx-1'])

    expect(snapshot.byTransaction.get('tx-1')).toMatchObject({ proposals: [assistant], inputHash: null })
    expect(snapshot.ruleVersion).toBe('bank-proposals.1')
  })

  it('never fails the booking: a failed read gives an empty snapshot', async () => {
    const { client } = fakeClient({ selectError: 'timeout' })

    const snapshot = await snapshotSuggestions(client as never, 'company-1', ['tx-1'])

    expect(snapshot).toEqual({ companyId: 'company-1', byTransaction: new Map() })
  })

  it('asks the bank proposals for exactly the rows it read, once', async () => {
    mockPropose.mockResolvedValue({ proposals: {}, assistant_reads: {} })
    const { client } = fakeClient({ transactions: [tx] })

    await snapshotSuggestions(client as never, 'company-1', ['tx-1'])

    expect(mockPropose).toHaveBeenCalledExactlyOnceWith(client, 'company-1', [tx])
  })

  it('never fails the booking: a failed proposal read gives a snapshot without suggestions or rules', async () => {
    mockPropose.mockRejectedValue(new Error('rules read failed'))
    const { client } = fakeClient({ transactions: [tx] })

    const snapshot = await snapshotSuggestions(client as never, 'company-1', ['tx-1'])

    expect(snapshot).toEqual({ companyId: 'company-1', byTransaction: new Map() })
  })

  it('asks nothing for an empty batch', async () => {
    const { client } = fakeClient()
    await snapshotSuggestions(client as never, 'company-1', [])
    expect(mockPropose).not.toHaveBeenCalled()
  })
})

describe('recordDecisions', () => {
  const snapshot: SuggestionSnapshot = {
    companyId: 'company-1',
    entityType: 'aktiebolag',
    ruleVersion: 'bank-proposals.1+a38016f12abc',
    byTransaction: new Map([['tx-1', { proposals: [assistant], read: null, documentId: 'doc-1', inputHash: 'f'.repeat(64) }]]),
  }
  const booked = finalFromLines('je-1', [
    { account: '6540', debit: 400, credit: 0 },
    { account: '2641', debit: 100, credit: 0 },
    { account: '1930', debit: 0, credit: 500 },
  ])

  it('writes one bank_line row per decision, classified, as the deciding user', async () => {
    const { client, inserts } = fakeClient()

    await recordDecisions(client as never, snapshot, [{ transactionId: 'tx-1', actedOn: 'assistant:tx-1', final: booked }], 'user-1')

    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe('suggestion_log')
    expect(inserts[0].rows).toEqual([
      expect.objectContaining({
        company_id: 'company-1',
        kind: 'bank_line',
        transaction_id: 'tx-1',
        document_id: 'doc-1',
        acted_on: 0,
        outcome: 'accepted',
        final: booked,
        actor_type: 'user',
        resolved_by: 'user-1',
        rule_version: 'bank-proposals.1+a38016f12abc',
        input_hash: 'f'.repeat(64),
        pending_operation_id: null,
        checks: null,
      }),
    ])
  })

  it("records the acted-on suggestion's band under the direct-booking policy, with the policy", async () => {
    const withRule: SuggestionSnapshot = {
      ...snapshot,
      byTransaction: new Map([['tx-1', { proposals: [ownRule, assistant], read: null, documentId: 'doc-1', inputHash: null }]]),
    }
    const { client, inserts } = fakeClient()

    await recordDecisions(client as never, withRule, [
      { transactionId: 'tx-1', actedOn: 'rule:r1', final: finalFromLines('je-1', [{ account: '5410', debit: 500, credit: 0 }, { account: '1930', debit: 0, credit: 500 }]) },
    ], 'user-1')
    await recordDecisions(client as never, withRule, [{ transactionId: 'tx-1', actedOn: 'assistant:tx-1', final: booked }], 'user-1')

    // A company rule of its own books from the row; an assistant read without a receipt behind it opens a review.
    expect(inserts[0].rows).toEqual([expect.objectContaining({ confidence_band: 'direct', policy_version: DIRECT_BOOKING_POLICY_VERSION })])
    expect(inserts[1].rows).toEqual([expect.objectContaining({ confidence_band: 'review', policy_version: DIRECT_BOOKING_POLICY_VERSION })])
  })

  it('records no band and no policy when no suggestion was acted on', async () => {
    const { client, inserts } = fakeClient()

    await recordDecisions(client as never, snapshot, [
      { transactionId: 'tx-1', final: booked },
      { transactionId: 'tx-1', final: null },
    ], 'user-1')

    expect(inserts[0].rows).toEqual([
      expect.objectContaining({ outcome: 'manual', confidence_band: null, policy_version: null }),
      expect.objectContaining({ outcome: 'dismissed', confidence_band: null, policy_version: null }),
    ])
  })

  it('records the guards the door ran, as it reported them', async () => {
    const { client, inserts } = fakeClient()
    const checks = [passed('already_booked'), warned('duplicate', 'force:journal_entry:je-0'), passed('period_lock')]

    await recordDecisions(client as never, snapshot, [{ transactionId: 'tx-1', final: booked, checks }], 'user-1')

    expect(inserts[0].rows).toEqual([expect.objectContaining({ checks })])
  })

  it('names the pending operation whose approval carried the decision', async () => {
    const { client, inserts } = fakeClient()

    await runInOperationCommit('op-1', () =>
      recordDecisions(client as never, snapshot, [{ transactionId: 'tx-1', final: booked }], 'user-1'),
    )

    expect(inserts[0].rows).toEqual([expect.objectContaining({ pending_operation_id: 'op-1' })])
  })

  it("copies the approved operation's agent_reason, and names no such column outside one", async () => {
    const { client, inserts } = fakeClient()

    await runInOperationCommit(
      'op-1',
      () => recordDecisions(client as never, snapshot, [{ transactionId: 'tx-1', final: booked }], 'user-1'),
      'Telia every month on 6212; this one has the same OCR series.',
    )
    await recordDecisions(client as never, snapshot, [{ transactionId: 'tx-1', final: booked }], 'user-1')

    expect(inserts[0].rows).toEqual([
      expect.objectContaining({ pending_operation_id: 'op-1', agent_reason: 'Telia every month on 6212; this one has the same OCR series.' }),
    ])
    expect((inserts[1].rows as Array<Record<string, unknown>>)[0]).not.toHaveProperty('agent_reason')
  })

  it('records the decision without the reason while the agent_reason column is not there yet', async () => {
    const inserts: Array<Array<Record<string, unknown>>> = []
    const client = {
      from: () => ({
        insert: async (rows: Array<Record<string, unknown>>) => {
          inserts.push(rows)
          return rows.some((row) => 'agent_reason' in row) ? { error: { code: 'PGRST204', message: 'no agent_reason' } } : { error: null }
        },
      }),
    }

    await runInOperationCommit(
      'op-1',
      () => recordDecisions(client as never, snapshot, [{ transactionId: 'tx-1', final: booked }], 'user-1'),
      'why',
    )

    expect(inserts).toHaveLength(2)
    expect(inserts[1][0]).toMatchObject({ pending_operation_id: 'op-1' })
    expect(inserts[1][0]).not.toHaveProperty('agent_reason')
  })

  it('keeps the assistant read on its suggestion, the reasoning as a hash', async () => {
    const withRead: SuggestionSnapshot = {
      ...snapshot,
      byTransaction: new Map([['tx-1', { proposals: [assistant], read: read as never, documentId: 'doc-1', inputHash: null }]]),
    }
    const { client, inserts } = fakeClient()

    await recordDecisions(client as never, withRead, [{ transactionId: 'tx-1', final: booked }], 'user-1')

    const [row] = inserts[0].rows as Array<{ suggestions: Array<Record<string, unknown>> }>
    expect(row.suggestions[0]).toMatchObject({
      source: 'assistant',
      model: 'm',
      prompt_sha256: 'h',
      agreement: 1,
      from_candidate: false,
      reasoning_sha256: sha256Hex('Kvittot visar en kabel.'),
    })
    expect(JSON.stringify(row)).not.toContain('Kvittot visar')
  })

  it('takes the actor from the commit scope (an API key relaying the decision)', async () => {
    mockGetActor.mockReturnValue({ type: 'api_key', label: 'Bokföringsagent' })
    const { client, inserts } = fakeClient()

    await recordDecisions(client as never, snapshot, [{ transactionId: 'tx-1', final: null }], 'user-1')

    expect(inserts[0].rows).toEqual([expect.objectContaining({ actor_type: 'api_key', outcome: 'dismissed', final: null })])
  })

  it('records a row without suggestions, rules or inputs for a transaction the snapshot missed', async () => {
    const { client, inserts } = fakeClient()

    await recordDecisions(client as never, snapshot, [{ transactionId: 'tx-2', final: booked }], 'user-1')

    expect(inserts[0].rows).toEqual([
      expect.objectContaining({ transaction_id: 'tx-2', suggestions: [], outcome: 'manual', rule_version: null, input_hash: null }),
    ])
  })

  it('never throws: a refused insert is logged and the booking stands', async () => {
    const { client } = fakeClient({ insertError: 'permission denied' })

    await expect(
      recordDecisions(client as never, snapshot, [{ transactionId: 'tx-1', final: booked }], 'user-1'),
    ).resolves.toBeUndefined()
  })
})

describe('snapshot and record together', () => {
  it('lets an auditor recompute the inputs hash from the recorded row, the bank line and the document', async () => {
    const sha = 'c'.repeat(64)
    mockPropose.mockResolvedValue({ proposals: { 'tx-1': [ownRule, assistant] }, assistant_reads: { 'tx-1': read } })
    const { client, inserts } = fakeClient({ transactions: [tx], documents: [{ id: 'doc-1', sha256_hash: sha }] })

    const snapshot = await snapshotSuggestions(client as never, 'company-1', ['tx-1'])
    await recordDecisions(client as never, snapshot, [
      { transactionId: 'tx-1', actedOn: 'rule:r1', final: finalFromLines('je-1', [{ account: '5410', debit: 500, credit: 0 }, { account: '1930', debit: 0, credit: 500 }]) },
    ], 'user-1')

    const [row] = inserts[0].rows as Array<{ input_hash: string; suggestions: Array<Record<string, unknown>> }>
    const recomputed = bankLineInputHash({
      transaction: tx as never,
      documentSha256: sha,
      suggestions: row.suggestions.map(({ matches_final: _matched, ...offered }) => offered) as never,
    })
    expect(row.input_hash).toBe(recomputed)
  })
})

describe('finalFromCategorize', () => {
  const journalEntry = { id: 'je-1', lines: [] }

  it('names a counterpart by its id', () => {
    const f = finalFromCategorize({
      journalEntry,
      mappingResult: { debit_account: '6230', credit_account: '1930' },
      amount: -500,
      counterpartyTemplateId: 'abc',
    })
    expect(f).toMatchObject({ booking: { kind: 'counterparty', counterparty_template_id: 'abc' }, account: '6230' })
  })

  it('takes the business account from the side the money moves: credit on money in', () => {
    const f = finalFromCategorize({
      journalEntry,
      mappingResult: { debit_account: '1930', credit_account: '3041' },
      amount: 1250,
      category: 'income_services',
      vatTreatment: 'standard_25',
    })
    expect(f).toMatchObject({
      account: '3041',
      booking: { kind: 'account', account: '3041', vat_treatment: 'standard_25', category: 'income_services' },
    })
  })

  it('names a catalog template and reads its VAT treatment from the catalog', () => {
    const f = finalFromCategorize({
      journalEntry,
      mappingResult: { debit_account: '6212', credit_account: '1930' },
      amount: -300,
      templateId: 'telecom_mobile',
      category: 'expense_telecom',
    })
    expect(f.booking).toEqual({ kind: 'template', template_id: 'telecom_mobile', category: 'expense_telecom' })
    expect(f.vat_treatment).not.toBeNull()
  })
})
