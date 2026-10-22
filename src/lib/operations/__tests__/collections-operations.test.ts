/**
 * The collections operations: invisible to the machine doors while
 * collections is switched off, still committable when staged earlier, and
 * answering the start gates the same way the routes do.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import type { CollectionCaseView } from '@/lib/collections/case'
import type { CollectionsGateFacts } from '@/lib/collections/flags'

const facts = vi.hoisted(() => ({ current: null as CollectionsGateFacts | null }))
vi.mock('@/lib/collections/availability', () => ({ loadCollectionsGateFacts: vi.fn(async () => facts.current) }))
const invoiceCase = vi.hoisted(() => ({ view: null as CollectionCaseView | null }))
vi.mock('@/lib/collections/invoice-collection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/collections/invoice-collection')>()),
  loadInvoiceCase: vi.fn(async () => invoiceCase.view),
}))
/** A client whose every read answers nothing. */
function emptyClient(): unknown {
  const chain: Record<string, unknown> = {}
  const self = () => chain
  for (const m of ['select', 'eq', 'neq', 'is', 'in', 'order', 'limit', 'not', 'gte', 'lte', 'gt', 'lt']) chain[m] = self
  chain.maybeSingle = async () => ({ data: null, error: null })
  chain.single = async () => ({ data: null, error: null })
  return { from: () => chain }
}
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => emptyClient() }))

const COLLECTION_IDS = [
  'collections.candidates.list',
  'collections.cases.get',
  'collections.cases.open',
  'collections.cases.action',
  'collections.settlements.list',
  'collections.payments.book',
  'collections.settlements.book',
]

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loadRegistry(enabled: boolean) {
  vi.resetModules()
  vi.stubEnv('COLLECTIONS_ENABLED', enabled ? '1' : '')
  return import('../registry')
}

// The registry imports every operation: loading it twice takes a while.
describe('collections operations in the registry', { timeout: 180_000 }, () => {
  it('are not served while collections is switched off, but a staged one still finds its operation', async () => {
    const registry = await loadRegistry(false)
    expect(registry.OPERATIONS.map((o) => o.id)).not.toEqual(expect.arrayContaining([COLLECTION_IDS[0]]))
    for (const id of COLLECTION_IDS) expect(registry.ALL_OPERATIONS.some((o) => o.id === id)).toBe(true)
    expect(registry.operationForPendingType('open_collection_case')?.id).toBe('collections.cases.open')
    expect(registry.operationForPendingType('collection_case_action')?.id).toBe('collections.cases.action')
    expect(registry.operationForPendingType('book_collected_payment')?.id).toBe('collections.payments.book')
    expect(registry.operationForPendingType('book_collection_settlement')?.id).toBe('collections.settlements.book')
  })

  it('are served once collections is switched on', async () => {
    const registry = await loadRegistry(true)
    for (const id of COLLECTION_IDS) expect(registry.OPERATIONS.some((o) => o.id === id)).toBe(true)
  })

  it('never name the provider in a tool name', async () => {
    const registry = await loadRegistry(true)
    const names = registry.OPERATIONS.filter((o) => COLLECTION_IDS.includes(o.id)).map((o) => o.mcp?.name)
    expect(names).toEqual([
      'gnubok_list_collection_candidates',
      'gnubok_get_collection_case',
      'gnubok_send_invoice_to_collection',
      'gnubok_collection_case_action',
      'gnubok_list_collection_settlements',
      'gnubok_book_collected_payment',
      'gnubok_book_collection_settlement',
    ])
  })
})

describe('collections.cases.open run()', () => {
  const ctx = {
    supabase: emptyClient() as never,
    companyId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ctx.log } as never,
  }

  it('answers the paywall code without the paid capability, and the kill switch while dark', async () => {
    const { collectionsCasesOpen } = await import('../collections')
    facts.current = { companyId: ctx.companyId, capability: false, sandbox: false, connection: null, obligations: { openCases: 0, unbookedCollectedPayments: 0, unbookedSettlements: 0 } }
    vi.stubEnv('COLLECTIONS_ENABLED', '1')
    vi.stubEnv('COLLECTIONS_PILOT_COMPANIES', '*')
    const input = { invoice_id: '55555555-5555-4555-8555-555555555555', expected_remaining: 100 }
    expect(await collectionsCasesOpen.run(ctx, input, { dryRun: true })).toMatchObject({ ok: false, code: 'COLLECTIONS_CAPABILITY_BLOCKED' })
    vi.stubEnv('COLLECTIONS_ENABLED', '')
    expect(await collectionsCasesOpen.run(ctx, input, { dryRun: true })).toMatchObject({ ok: false, code: 'COLLECTIONS_DISABLED' })
  })
})

describe('collections.candidates.list input', () => {
  it('takes include_ineligible as a boolean (MCP) or as the query string words true and false (v1 GET)', async () => {
    const { collectionsCandidatesList } = await import('../collections')
    for (const value of [true, false, 'true', 'false', undefined]) {
      expect(collectionsCandidatesList.input.safeParse(value === undefined ? {} : { include_ineligible: value }).success).toBe(true)
    }
    expect(collectionsCandidatesList.input.safeParse({ include_ineligible: 'yes' }).success).toBe(false)
  })
})

describe('collections case tools output', () => {
  it('qualify every identifier (no bare id), as the MCP tool rules require', async () => {
    const { COLLECTIONS_OPERATION_LIST } = await import('../collections')
    const bare: string[] = []
    const walk = (schema: unknown, path: string) => {
      if (!schema || typeof schema !== 'object') return
      const node = schema as { properties?: Record<string, unknown>; items?: unknown; anyOf?: unknown[] }
      if (node.properties) {
        if ('id' in node.properties) bare.push(path)
        for (const [key, value] of Object.entries(node.properties)) walk(value, `${path}.${key}`)
      }
      if (node.items) walk(node.items, `${path}[]`)
      for (const option of node.anyOf ?? []) walk(option, path)
    }
    for (const op of COLLECTIONS_OPERATION_LIST) walk(z.toJSONSchema(op.output as z.ZodTypeAny, { io: 'output', unrepresentable: 'any' }), op.id)
    expect(bare).toEqual([])
  })

  it('collections.cases.get answers the case with case_id, invoice_id and event_id, in snake_case', async () => {
    const { collectionsCasesGet } = await import('../collections')
    const invoiceId = '55555555-5555-4555-8555-555555555555'
    const caseId = '2b9c1e2f-4b5c-4d6e-8f70-819203a4b5c6'
    invoiceCase.view = {
      id: caseId,
      invoiceId,
      origin: 'handover',
      startStep: 'reminder',
      submissionStatus: 'registered',
      caseNumber: '7731',
      merged: false,
      stage: 'closed_paid',
      decisionKind: null,
      isOpen: false,
      closeReason: 'paid',
      providerStateLabel: 'Betald',
      nextActionDate: null,
      nextActionLabel: null,
      actions: [],
      claimAmount: 1250,
      outstandingPrincipal: 0,
      outstandingTotal: 0,
      pausedBySweep: false,
      pauseReason: null,
      outstandingMismatch: null,
      possiblePayments: [],
      forwardIssues: [],
      forwardsInFlight: false,
      openedAt: '2026-10-01T08:00:00.000Z',
      closedAt: '2026-10-06T08:00:00.000Z',
      lastSyncedAt: '2026-10-06T08:00:00.000Z',
      syncError: null,
      events: [
        { id: 'ev-1', occurredAt: '2026-10-02T08:00:00.000Z', kind: 'letter', stageFrom: 'registered', stageTo: 'reminder', direction: 'to_debtor', label: 'Påminnelse skickad', labelKey: null, amount: null },
      ],
    } satisfies CollectionCaseView
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq']) chain[m] = () => chain
    chain.maybeSingle = async () => ({ data: { id: invoiceId }, error: null })
    const ctx = {
      supabase: { from: () => chain } as never,
      companyId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    }
    const outcome = await collectionsCasesGet.run(ctx, { invoice_id: invoiceId }, { dryRun: false })
    expect(outcome).toMatchObject({
      ok: true,
      data: {
        case: {
          case_id: caseId,
          invoice_id: invoiceId,
          submission_status: 'registered',
          is_open: false,
          close_reason: 'paid',
          events: [{ event_id: 'ev-1', stage_to: 'reminder' }],
        },
        withdraw_fee: null,
      },
    })
    const data = (outcome as { data: Record<string, unknown> }).data
    expect(collectionsCasesGet.output.safeParse(data).success).toBe(true)
    expect(data.case).not.toHaveProperty('id')
  })
})
