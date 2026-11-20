/**
 * What the collections operations hand the case services when an agent
 * stages them through MCP: always the agent channel (no attestations, no
 * "not this payment" dismissals), the withdraw fee acknowledgment, and the
 * withdraw fee facts an agent reads before asking the user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  facts: vi.fn(),
  handOverInvoice: vi.fn(),
  runCaseAction: vi.fn(),
  loadInvoiceCase: vi.fn(),
  loadLiveConnection: vi.fn(),
  getCollectionsProvider: vi.fn(),
  loadCaseEvents: vi.fn(),
}))

vi.mock('@/lib/collections/availability', () => ({ loadCollectionsGateFacts: mocks.facts }))
vi.mock('@/lib/collections/case-actions', () => ({ handOverInvoice: mocks.handOverInvoice, runCaseAction: mocks.runCaseAction }))
vi.mock('@/lib/collections/invoice-collection', () => ({ loadInvoiceCase: mocks.loadInvoiceCase }))
vi.mock('@/lib/collections/connection', () => ({ loadLiveConnection: mocks.loadLiveConnection }))
vi.mock('@/lib/collections/catalogue', () => ({ getCollectionsProvider: mocks.getCollectionsProvider }))
/** A whole case view: the tools map every field of it. */
const view = vi.hoisted(
  () =>
    (overrides: Record<string, unknown> = {}) => ({
      id: 'case-1',
      invoiceId: '7d1e2f3a-4b5c-4d6e-8f70-819203a4b5c6',
      origin: 'handover',
      startStep: 'reminder',
      submissionStatus: 'registered',
      caseNumber: null,
      merged: false,
      stage: 'reminder',
      decisionKind: null,
      isOpen: true,
      closeReason: null,
      providerStateLabel: null,
      nextActionDate: null,
      nextActionLabel: null,
      actions: [],
      claimAmount: 1250,
      outstandingPrincipal: 1250,
      outstandingTotal: 1250,
      pausedBySweep: false,
      openedAt: '2026-10-01T08:00:00.000Z',
      closedAt: null,
      lastSyncedAt: null,
      syncError: null,
      events: [],
      ...overrides,
    }),
)

vi.mock('@/lib/collections/case', () => ({
  loadCaseEvents: mocks.loadCaseEvents,
  caseView: (row: { id: string; stage: string }) => view({ id: row.id, stage: row.stage }),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ from: vi.fn() }) }))

import { collectionsCasesAction, collectionsCasesGet, collectionsCasesOpen } from '../collections'

const INVOICE_ID = '7d1e2f3a-4b5c-4d6e-8f70-819203a4b5c6'

/** A caller's client whose invoice lookup answers `invoice`. */
function client(invoice: { id: string } | null) {
  const chain: Record<string, unknown> = {}
  const self = () => chain
  for (const m of ['select', 'eq']) chain[m] = self
  chain.maybeSingle = async () => ({ data: invoice, error: null })
  return { from: () => chain }
}

function ctx(invoice: { id: string } | null = { id: INVOICE_ID }) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { supabase: client(invoice) as never, companyId: 'company-1', userId: 'user-1', log: log as never }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.facts.mockResolvedValue({ companyId: 'company-1', capability: true, connection: null, obligations: {} })
  mocks.loadCaseEvents.mockResolvedValue([])
  mocks.loadLiveConnection.mockResolvedValue({ id: 'conn-1', route: 'fake', display_name: 'Acme Inkasso' })
  mocks.getCollectionsProvider.mockResolvedValue({ features: { withdrawFreeDays: 14 } })
})

describe('collections.cases.action', () => {
  it('runs as the agent channel and passes the withdraw fee acknowledgment', async () => {
    mocks.runCaseAction.mockResolvedValue({ ok: true, case: { id: 'case-1', stage: 'closed_other' } })
    const outcome = await collectionsCasesAction.run(
      ctx(),
      { invoice_id: INVOICE_ID, action: 'withdraw', fee_acknowledged: true },
      { dryRun: false },
    )
    expect(outcome).toMatchObject({ ok: true, data: { case: { case_id: 'case-1', stage: 'closed_other' } } })
    const [deps, input] = mocks.runCaseAction.mock.calls[0]
    expect(deps).toMatchObject({ channel: 'agent', companyId: 'company-1', actor: { userId: 'user-1' } })
    expect(input).toMatchObject({ invoiceId: INVOICE_ID, action: 'withdraw', feeAcknowledged: true })
    // An agent never carries a person's attestation or dismissal.
    expect(input.attestations).toBeUndefined()
    expect(input.dismissedTransactionIds).toBeUndefined()
  })

  it('leaves the acknowledgment off unless the agent says so, and answers the service refusal', async () => {
    mocks.runCaseAction.mockResolvedValue({ ok: false, code: 'COLLECTION_WITHDRAW_FEE_UNACKNOWLEDGED', status: 409, details: { free_days: 14 } })
    const outcome = await collectionsCasesAction.run(ctx(), { invoice_id: INVOICE_ID, action: 'withdraw' }, { dryRun: false })
    expect(mocks.runCaseAction.mock.calls[0][1].feeAcknowledged).toBe(false)
    expect(outcome).toMatchObject({ ok: false, code: 'COLLECTION_WITHDRAW_FEE_UNACKNOWLEDGED' })
  })

  it('previews a dry run without writing', async () => {
    mocks.runCaseAction.mockResolvedValue({ ok: true, dryRun: true, preview: { action: 'pause' } })
    const outcome = await collectionsCasesAction.run(
      ctx(),
      { invoice_id: INVOICE_ID, action: 'pause', until: '2026-11-01' },
      { dryRun: true },
    )
    expect(outcome).toEqual({ ok: true, dryRun: true, preview: { action: 'pause' } })
    expect(mocks.runCaseAction.mock.calls[0][1]).toMatchObject({ until: '2026-11-01', dryRun: true })
  })

  it('titles the staged operation in Swedish per action', () => {
    const title = collectionsCasesAction.mcp?.stage?.title
    expect(title?.({ invoice_id: INVOICE_ID, action: 'approve_step' } as never)).toBe('Inkassoärende: godkänn nästa steg')
    expect(title?.({ invoice_id: INVOICE_ID, action: 'pause' } as never)).toBe('Inkassoärende: pausa')
    expect(title?.({ invoice_id: INVOICE_ID, action: 'nonsense' } as never)).toBe('Åtgärd i inkassoärende')
  })
})

describe('collections.cases.open', () => {
  it('hands attestation fields to the service as the agent channel, which refuses them', async () => {
    mocks.handOverInvoice.mockResolvedValue({ ok: false, code: 'COLLECTION_ATTESTATION_WEB_ONLY', status: 403 })
    const outcome = await collectionsCasesOpen.run(
      ctx(),
      { invoice_id: INVOICE_ID, expected_remaining: 1250, bank_attested: true },
      { dryRun: true },
    )
    const [deps, input] = mocks.handOverInvoice.mock.calls[0]
    expect(deps.channel).toBe('agent')
    expect(input).toMatchObject({ invoiceId: INVOICE_ID, expectedRemaining: 1250, attestations: { bank: true }, dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'COLLECTION_ATTESTATION_WEB_ONLY' })
  })

  it('answers a missing paid capability with the capability code', async () => {
    mocks.handOverInvoice.mockResolvedValue({ ok: false, code: 'CAPABILITY_REQUIRED', status: 403 })
    const outcome = await collectionsCasesOpen.run(ctx(), { invoice_id: INVOICE_ID, expected_remaining: 1250 }, { dryRun: true })
    expect(outcome).toEqual({ ok: false, code: 'COLLECTIONS_CAPABILITY_BLOCKED' })
  })
})

describe('collections.cases.get', () => {
  it('says whether withdrawing an open case may cost a fee', async () => {
    mocks.loadInvoiceCase.mockResolvedValue(view({ isOpen: true, openedAt: '2020-01-01T00:00:00.000Z' }))
    const outcome = await collectionsCasesGet.run(ctx(), { invoice_id: INVOICE_ID }, { dryRun: false })
    expect(outcome).toMatchObject({
      ok: true,
      data: { case: { case_id: 'case-1', is_open: true }, withdraw_fee: { may_apply: true, free_days: 14, free_until: '2020-01-15T00:00:00.000Z' } },
    })
  })

  it('has no fee line for a closed case or an invoice never handed over', async () => {
    mocks.loadInvoiceCase.mockResolvedValueOnce(view({ isOpen: false, openedAt: '2020-01-01T00:00:00.000Z' }))
    expect(await collectionsCasesGet.run(ctx(), { invoice_id: INVOICE_ID }, { dryRun: false })).toMatchObject({ ok: true, data: { withdraw_fee: null } })
    mocks.loadInvoiceCase.mockResolvedValueOnce(null)
    expect(await collectionsCasesGet.run(ctx(), { invoice_id: INVOICE_ID }, { dryRun: false })).toEqual({
      ok: true,
      data: { case: null, withdraw_fee: null },
    })
  })

  it('answers 404 for an invoice of another company', async () => {
    const outcome = await collectionsCasesGet.run(ctx(null), { invoice_id: INVOICE_ID }, { dryRun: false })
    expect(outcome).toEqual({ ok: false, code: 'INVOICE_NOT_FOUND' })
    expect(mocks.loadInvoiceCase).not.toHaveBeenCalled()
  })
})
