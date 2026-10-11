import { describe, it, expect, vi, beforeEach } from 'vitest'
import { accountProposal } from '@/lib/bookkeeping/proposal'
import { finalFromCategorize, finalFromLines, recordDecisions, snapshotSuggestions, type SuggestionSnapshot } from '../record'

const mockPropose = vi.fn()
vi.mock('@/lib/transactions/propose', () => ({
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

/** The two query shapes the module uses: a select of transactions, an insert into suggestion_log. */
function fakeClient(opts: { transactions?: unknown[]; selectError?: string; insertError?: string } = {}) {
  const inserts: Array<{ table: string; rows: unknown }> = []
  const client = {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            in: async () =>
              opts.selectError
                ? { data: null, error: { message: opts.selectError } }
                : { data: opts.transactions ?? [], error: null },
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

beforeEach(() => {
  vi.clearAllMocks()
  mockGetActor.mockReturnValue(undefined)
})

describe('snapshotSuggestions', () => {
  it('keeps what was on offer per transaction, with the assistant read and the row document', async () => {
    const read = { transaction_id: 'tx-1', model: 'm', prompt_sha256: 'h' }
    mockPropose.mockResolvedValue({ proposals: { 'tx-1': [assistant] }, assistant_reads: { 'tx-1': read } })
    const { client } = fakeClient({ transactions: [{ id: 'tx-1', document_id: 'doc-1' }] })

    const snapshot = await snapshotSuggestions(client as never, 'company-1', ['tx-1'])

    expect(snapshot.entityType).toBe('aktiebolag')
    expect(snapshot.byTransaction.get('tx-1')).toEqual({ proposals: [assistant], read, documentId: 'doc-1' })
  })

  it('never fails the booking: a failed read gives an empty snapshot', async () => {
    const { client } = fakeClient({ selectError: 'timeout' })

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
    byTransaction: new Map([['tx-1', { proposals: [assistant], read: null, documentId: 'doc-1' }]]),
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
      }),
    ])
  })

  it('takes the actor from the commit scope (an API key relaying the decision)', async () => {
    mockGetActor.mockReturnValue({ type: 'api_key', label: 'Bokföringsagent' })
    const { client, inserts } = fakeClient()

    await recordDecisions(client as never, snapshot, [{ transactionId: 'tx-1', final: null }], 'user-1')

    expect(inserts[0].rows).toEqual([expect.objectContaining({ actor_type: 'api_key', outcome: 'dismissed', final: null })])
  })

  it('records a row without suggestions for a transaction the snapshot missed', async () => {
    const { client, inserts } = fakeClient()

    await recordDecisions(client as never, snapshot, [{ transactionId: 'tx-2', final: booked }], 'user-1')

    expect(inserts[0].rows).toEqual([expect.objectContaining({ transaction_id: 'tx-2', suggestions: [], outcome: 'manual' })])
  })

  it('never throws: a refused insert is logged and the booking stands', async () => {
    const { client } = fakeClient({ insertError: 'permission denied' })

    await expect(
      recordDecisions(client as never, snapshot, [{ transactionId: 'tx-1', final: booked }], 'user-1'),
    ).resolves.toBeUndefined()
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
