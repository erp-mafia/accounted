import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'
import { runWithTrace } from '@/lib/observability/trace-context-node'
import { bankExclusion, batchTitle, ladderDueCutoff, LADDER_RUN_BUDGET_MS, resolveBatchOwner, runLadderCron, scanDecision } from '../autopilot'
import { COLLECTIONS_BATCH_TYPE, type BatchParams } from '../batch'
import { batches, caseAfter, gather, LADDER_ENV, ladderWorld, OWNER_ID, stage } from './batch-fixtures'
import { CUSTOMER_ID, ENV_ON, INVOICE_ID, OPENED_AT, type CaseWorld } from './case-fixtures'
import { ADMIN_ID, COMPANY_ID } from './memory-supabase'

vi.mock('../case-document', async () => {
  const { TEST_DOCUMENT: document } = await import('./case-fixtures')
  return {
    HandoverDocumentError: class extends Error {},
    resolveHandoverDocument: vi.fn(async () => document),
    readArchivedDocument: vi.fn(async () => document),
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('pure rules', () => {
  it('considers invoices due on or before today minus the ladder days', () => {
    expect(ladderDueCutoff('2026-10-06', 10)).toBe('2026-09-26')
  })

  it('names the bank outcome that keeps an invoice out', () => {
    expect(bankExclusion({ outcome: 'pass' })).toBeNull()
    expect(bankExclusion({ outcome: 'candidates' })).toBe('candidates')
    expect(bankExclusion({ outcome: 'stale' })).toBe('bank_stale')
    expect(bankExclusion({ outcome: 'no_bank' })).toBe('bank_stale')
  })

  it('ignores an invoice already at the provider past delivery, and starts a watching one', () => {
    const eligibility = { blocks: [{ code: 'elig_open_case' as const }], deliveryAttestation: null, responseAttestation: null } as never
    expect(scanDecision({ eligibility, openCase: { id: 'c', stage: 'reminder', submission_status: 'registered' }, imported: false, customerExcluded: false })).toEqual({
      kind: 'ignore',
    })
    expect(scanDecision({ eligibility, openCase: { id: 'c', stage: 'invoice_sent', submission_status: 'registered' }, imported: false, customerExcluded: false })).toEqual({
      kind: 'check_bank',
      itemKind: 'start',
    })
  })

  it('titles the staged operation in Swedish', () => {
    expect(batchTitle('2026-10-06', 1)).toBe('Inkassoomgång 2026-10-06: 1 faktura att granska')
    expect(batchTitle('2026-10-06', 3)).toBe('Inkassoomgång 2026-10-06: 3 fakturor att granska')
  })
})

describe('gatherDailyBatch', () => {
  it('proposes an overdue, delivered, unpaid invoice whose bank check passed', async () => {
    const world = await ladderWorld()
    const batch = await gather(world)
    expect(batch.batchDate).toBe('2026-10-06')
    expect(batch.excluded).toEqual([])
    expect(batch.items).toEqual([
      {
        kind: 'open',
        invoice_id: INVOICE_ID,
        case_id: null,
        invoice_number: '20261042',
        customer_name: expect.any(String),
        due_date: '2026-08-31',
        remaining_amount: 1250,
        start_step: 'reminder',
        decision_kind: null,
        reminder_fee_agreed: true,
        bank_check: 'pass',
      },
    ])
  })

  it('proposes the inkassokrav instead of a reminder when no reminder fee is agreed', async () => {
    const world = await ladderWorld()
    world.db.rows('collection_connections')[0]!.reminder_fee_terms_since = null
    const batch = await gather(world)
    expect(batch.items).toEqual([expect.objectContaining({ kind: 'open', start_step: 'collection', reminder_fee_agreed: false })])
  })

  it('leaves out an invoice not yet past the ladder days, without listing it', async () => {
    const world = await ladderWorld({ invoice: { due_date: '2026-09-30' } })
    const batch = await gather(world)
    expect(batch.items).toEqual([])
    expect(batch.excluded).toEqual([])
  })

  it.each([
    [
      'below the minimum amount',
      (w: CaseWorld) => {
        w.db.rows('collection_connections')[0]!.minimum_amount = 5000
      },
      'below_minimum',
    ],
    [
      'imported from an earlier system',
      (w: CaseWorld) => w.db.seed('migration_source_records', [{ company_id: COMPANY_ID, resource: 'salesInvoices', target_id: INVOICE_ID }]),
      'imported',
    ],
    [
      'not shown to have reached the customer',
      (w: CaseWorld) => {
        w.db.rows('invoice_deliveries')[0]!.provider_status = 'bounced'
      },
      'not_delivered',
    ],
    [
      'answered by the customer',
      (w: CaseWorld) => w.db.seed('invoice_reminders', [{ id: 'r-1', invoice_id: INVOICE_ID, response_type: 'disputed' }]),
      'response',
    ],
    [
      'with a stale bank for the account the customer pays to',
      (w: CaseWorld) => {
        w.db.rows('bank_connections')[0]!.last_synced_at = new Date(OPENED_AT - 30 * 3_600_000).toISOString()
      },
      'bank_stale',
    ],
    [
      'with an unbooked bank row that may be its payment',
      (w: CaseWorld) =>
        w.db.seed('open_bank_rows', [
          {
            id: 'tx-1',
            company_id: COMPANY_ID,
            date: '2026-09-20',
            amount: 1250,
            description: 'Betalning 20261042',
            original_description: null,
            merchant_name: null,
            reference: null,
            potential_invoice_id: null,
            is_ignored: false,
            invoice_id: null,
            supplier_invoice_id: null,
            journal_entry_id: null,
            is_business: true,
          },
        ]),
      'candidates',
    ],
    [
      'of a customer marked "Skicka aldrig till inkasso"',
      (w: CaseWorld) => {
        const invoice = w.db.rows('invoices')[0]!
        invoice.customer = { ...(invoice.customer as Record<string, unknown>), collections_excluded: true }
      },
      'customer_excluded',
    ],
  ] as const)('lists an invoice %s as excluded, with its reason', async (_label, arrange, reason) => {
    const world = await ladderWorld()
    arrange(world)
    const batch = await gather(world)
    expect(batch.items).toEqual([])
    expect(batch.excluded).toEqual([expect.objectContaining({ kind: 'open', invoice_id: INVOICE_ID, reason })])
  })

  it('names the first failed requirement of an otherwise ineligible invoice', async () => {
    const world = await ladderWorld({ invoice: { currency: 'EUR' } })
    const batch = await gather(world)
    expect(batch.excluded).toEqual([expect.objectContaining({ reason: 'ineligible', block: 'elig_currency' })])
  })

  it('proposes approving the next step of a case waiting for it, with what the books still say is owed', async () => {
    const world = await ladderWorld()
    const row = await caseAfter(world, 6)
    expect(row).toMatchObject({ stage: 'awaiting_decision', decision_kind: 'approve_collection_notice' })
    const batch = await gather(world)
    expect(batch.items).toEqual([
      expect.objectContaining({
        kind: 'approve_step',
        invoice_id: INVOICE_ID,
        case_id: row.id,
        decision_kind: 'approve_collection_notice',
        start_step: null,
        remaining_amount: 1250,
        reminder_fee_agreed: null,
        bank_check: 'pass',
      }),
    ])
  })

  it('keeps a waiting decision out while a bank row may be the payment', async () => {
    const world = await ladderWorld()
    await caseAfter(world, 6)
    world.db.seed('open_bank_rows', [
      {
        id: 'tx-2',
        company_id: COMPANY_ID,
        date: '2026-10-05',
        amount: 1250,
        description: 'Betalning 20261042',
        original_description: null,
        merchant_name: null,
        reference: null,
        potential_invoice_id: null,
        is_ignored: false,
        invoice_id: null,
        supplier_invoice_id: null,
        journal_entry_id: null,
        is_business: true,
      },
    ])
    const batch = await gather(world)
    expect(batch.items).toEqual([])
    expect(batch.excluded).toEqual([expect.objectContaining({ kind: 'approve_step', reason: 'candidates' })])
  })

  it('proposes starting reminders on an invoice the provider only delivered', async () => {
    const world = await ladderWorld()
    const row = await caseAfter(world, 0)
    Object.assign(world.db.rows('collection_cases').find((r) => r.id === row.id)!, { stage: 'invoice_sent', actions: ['start', 'withdraw'] })
    const batch = await gather(world)
    expect(batch.items).toEqual([expect.objectContaining({ kind: 'start', case_id: row.id, start_step: 'reminder' })])
  })

  it('says nothing about an invoice already at the provider', async () => {
    const world = await ladderWorld()
    await caseAfter(world, 2)
    const batch = await gather(world)
    expect(batch.items).toEqual([])
    expect(batch.excluded).toEqual([])
  })
})

describe('stageDailyBatch', () => {
  it('stages one high-risk operation under the person who chose the ladder, and contacts no provider', async () => {
    const world = await ladderWorld()
    const calls = vi.spyOn(world.adapter, 'openCase')
    const outcome = await stage(world)
    expect(outcome).toMatchObject({ status: 'staged', items: 1, excluded: 0, expired: 0 })
    const [op] = batches(world)
    expect(op).toMatchObject({
      company_id: COMPANY_ID,
      user_id: ADMIN_ID,
      operation_type: COLLECTIONS_BATCH_TYPE,
      risk_level: 'high',
      actor_type: 'cron',
      title: 'Inkassoomgång 2026-10-06: 1 faktura att granska',
    })
    expect((op!.params as BatchParams).items).toHaveLength(1)
    expect(op!.preview_data).toMatchObject({ item_count: 1, counts: { open: 1, start: 0, approve_step: 0 }, remaining_total: 1250, provider: 'Acme Inkasso' })
    expect(calls).not.toHaveBeenCalled()
    expect(world.openRequests).toEqual([])
    expect(world.db.rows('collection_cases')).toEqual([])
    // Outside a request scope: no trace.
    expect(op!.trace_id ?? null).toBeNull()
  })

  it('stamps the trace id of the run that staged the batch', async () => {
    const world = await ladderWorld()
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    expect(await runWithTrace(traceId, () => stage(world))).toMatchObject({ status: 'staged' })
    expect(batches(world)[0]).toMatchObject({ operation_type: COLLECTIONS_BATCH_TYPE, trace_id: traceId })
  })

  it('stages nothing when nothing qualifies', async () => {
    const world = await ladderWorld({ invoice: { due_date: '2026-10-01' } })
    expect(await stage(world)).toEqual({ status: 'empty', excluded: 0, expired: 0 })
    expect(batches(world)).toEqual([])
  })

  it('stages one batch a day, none while one is pending, and replaces its own after 72 hours', async () => {
    const world = await ladderWorld()
    expect((await stage(world)).status).toBe('staged')
    expect(await stage(world)).toMatchObject({ status: 'pending_exists' })

    // The pending one is decided; the same day still gets no second batch.
    batches(world)[0]!.status = 'rejected'
    expect(await stage(world)).toMatchObject({ status: 'already_staged' })

    // A day later a new batch; it waits; 73 hours on, the cron rejects it as expired and stages the day's.
    const bank = world.db.rows('bank_connections')[0]!
    world.clock.now = OPENED_AT + 24 * 3_600_000
    bank.last_synced_at = new Date(world.clock.now - 3_600_000).toISOString()
    expect((await stage(world)).status).toBe('staged')
    world.clock.now = OPENED_AT + (24 + 73) * 3_600_000
    bank.last_synced_at = new Date(world.clock.now - 3_600_000).toISOString()
    expect(await stage(world)).toMatchObject({ status: 'staged', expired: 1 })
    const [first, second, third] = batches(world)
    expect(first!.status).toBe('rejected')
    expect(second).toMatchObject({ status: 'rejected', result_data: { auto_rejected: true, reason: 'expired' } })
    expect(third!.status).toBe('pending')
  })

  it('falls back to the owner when the person who chose the ladder left, and stages nothing without one', async () => {
    const world = await ladderWorld()
    expect(await resolveBatchOwner(world.db.client, COMPANY_ID, ADMIN_ID)).toBe(ADMIN_ID)
    expect(await resolveBatchOwner(world.db.client, COMPANY_ID, CUSTOMER_ID)).toBe(OWNER_ID)
    world.db.rows('company_members').splice(0)
    expect(await resolveBatchOwner(world.db.client, COMPANY_ID, ADMIN_ID)).toBeNull()
    expect(await stage(world)).toMatchObject({ status: 'no_owner' })
    expect(batches(world)).toEqual([])
  })
})

describe('runLadderCron', () => {
  function cronDeps(world: CaseWorld, overrides: Partial<Parameters<typeof runLadderCron>[0]> = {}) {
    return {
      db: world.db.client as unknown as SupabaseClient,
      env: LADDER_ENV,
      now: world.now,
      loadFacts: async () => world.facts({ connection: { ...world.facts().connection!, ladderMode: 'staged' } }),
      providerFeatures: async () => null,
      ...overrides,
    }
  }

  it('does nothing at all while the ladder or collections are switched off', async () => {
    const world = await ladderWorld()
    const from = vi.spyOn(world.db.client, 'from')
    expect(await runLadderCron(cronDeps(world, { env: ENV_ON }))).toMatchObject({ enabled: false, companies: 0 })
    expect(await runLadderCron(cronDeps(world, { env: { ...LADDER_ENV, enabled: false } }))).toMatchObject({ enabled: false })
    expect(from).not.toHaveBeenCalled()
  })

  it('stages for a company whose gates say yes, and never opens a case or acts on one', async () => {
    const world = await ladderWorld()
    const openCase = vi.spyOn(world.adapter, 'openCase')
    const caseAction = vi.spyOn(world.adapter, 'caseAction')
    const summary = await runLadderCron(cronDeps(world))
    expect(summary).toMatchObject({ enabled: true, companies: 1, staged: 1, gated: 0, failed: 0 })
    expect(batches(world)).toHaveLength(1)
    expect(openCase).not.toHaveBeenCalled()
    expect(caseAction).not.toHaveBeenCalled()
    expect(world.openRequests).toEqual([])
  })

  it('skips a company whose start gates say no (no paid capability, not on the pilot list)', async () => {
    const world = await ladderWorld()
    const noCapability = await runLadderCron(cronDeps(world, { loadFacts: async () => world.facts({ capability: false }) }))
    expect(noCapability).toMatchObject({ companies: 1, gated: 1, staged: 0 })
    const offPilot = await runLadderCron(cronDeps(world, { env: { ...LADDER_ENV, pilot: new Set() } }))
    expect(offPilot).toMatchObject({ gated: 1, staged: 0 })
    expect(batches(world)).toEqual([])
  })

  it('reads only connections that are active with the ladder staged', async () => {
    const world = await ladderWorld()
    world.db.rows('collection_connections')[0]!.ladder_mode = 'off'
    expect(await runLadderCron(cronDeps(world))).toMatchObject({ companies: 0, staged: 0 })
  })

  it('still rejects a batch left waiting 72 hours where it can no longer be approved, and leaves a younger one', async () => {
    const world = await ladderWorld()
    const now = world.now().getTime()
    world.db.seed('pending_operations', [
      { id: 'stale-1', company_id: COMPANY_ID, operation_type: 'collections_daily_batch', status: 'pending', created_at: new Date(now - 73 * 3_600_000).toISOString() },
      { id: 'young-1', company_id: 'another-company', operation_type: 'collections_daily_batch', status: 'pending', created_at: new Date(now - 20 * 3_600_000).toISOString() },
      { id: 'other-1', company_id: COMPANY_ID, operation_type: 'create_invoice', status: 'pending', created_at: new Date(now - 100 * 3_600_000).toISOString() },
    ])
    // Gated: the company's own staging never runs, but the sweep does.
    const summary = await runLadderCron(cronDeps(world, { loadFacts: async () => world.facts({ capability: false }) }))
    expect(summary).toMatchObject({ gated: 1, staged: 0, expired: 1 })
    const rows = world.db.rows('pending_operations')
    expect(rows.find((r) => r.id === 'stale-1')).toMatchObject({ status: 'rejected', result_data: { auto_rejected: true, reason: 'expired' } })
    expect(rows.find((r) => r.id === 'young-1')).toMatchObject({ status: 'pending' })
    expect(rows.find((r) => r.id === 'other-1')).toMatchObject({ status: 'pending' })
  })

  it('rejects a batch on the third daily run after it, also when that run starts seconds short of 72 hours', async () => {
    const world = await ladderWorld()
    const now = world.now().getTime()
    world.db.seed('pending_operations', [
      // Staged a few seconds into its run; today's run fired a few seconds early.
      { id: 'third-run', company_id: COMPANY_ID, operation_type: 'collections_daily_batch', status: 'pending', created_at: new Date(now - 72 * 3_600_000 + 8_000).toISOString() },
      { id: 'second-run', company_id: 'another-company', operation_type: 'collections_daily_batch', status: 'pending', created_at: new Date(now - 48 * 3_600_000 + 8_000).toISOString() },
    ])
    const summary = await runLadderCron(cronDeps(world, { loadFacts: async () => world.facts({ capability: false }) }))
    expect(summary).toMatchObject({ expired: 1 })
    const rows = world.db.rows('pending_operations')
    expect(rows.find((r) => r.id === 'third-run')).toMatchObject({ status: 'rejected', result_data: { auto_rejected: true, reason: 'expired' } })
    expect(rows.find((r) => r.id === 'second-run')).toMatchObject({ status: 'pending' })
  })

  it('keeps going when one company fails', async () => {
    const world = await ladderWorld()
    const summary = await runLadderCron(
      cronDeps(world, {
        loadFacts: async () => {
          throw new Error('boom')
        },
      }),
    )
    expect(summary).toMatchObject({ companies: 1, failed: 1, staged: 0 })
  })

  describe('inside the run budget', () => {
    /** Three companies on the ladder; each one's turn takes a minute of the run's clock. */
    async function threeCompanies() {
      const world = await ladderWorld()
      const base = world.db.rows('collection_connections')[0]!
      world.db.rows('collection_connections').length = 0
      // Stored out of order: the run must not depend on how the rows come back.
      world.db.seed('collection_connections', ['company-c', 'company-a', 'company-b'].map((company_id) => ({ ...base, id: `conn-${company_id}`, company_id })))
      const timer = { ms: 0 }
      const visited: string[] = []
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
      const deps = (overrides: Partial<Parameters<typeof runLadderCron>[0]> = {}) =>
        cronDeps(world, {
          clock: () => timer.ms,
          log: logger as unknown as Logger,
          // Gated: the order and the deadline are what is under test, not the staging.
          loadFacts: async (_db, companyId) => {
            visited.push(companyId)
            timer.ms += 60_000
            return world.facts({ capability: false })
          },
          ...overrides,
        })
      return { world, timer, visited, logger, deps }
    }

    it('stops at the deadline, counts the companies it did not reach and reports them as an error', async () => {
      // There was no limit at all: past maxDuration the run was killed wherever it stood.
      const { visited, logger, deps } = await threeCompanies()
      const summary = await runLadderCron(deps({ deadlineMs: 120_000 }))
      expect(visited).toEqual(['company-a', 'company-b'])
      expect(summary).toMatchObject({ companies: 2, gated: 2, notReached: 1 })
      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledWith('collections ladder ran out of time before every company was reached', { notReached: 1, reached: 2 })
    })

    it('reaches every company inside the default budget, and says nothing', async () => {
      const { visited, logger, deps } = await threeCompanies()
      const summary = await runLadderCron(deps())
      expect(LADDER_RUN_BUDGET_MS).toBe(240_000)
      expect(visited).toEqual(['company-a', 'company-b', 'company-c'])
      expect(summary).toMatchObject({ companies: 3, notReached: 0 })
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('takes the companies without today\'s batch first, so a rerun does not spend its time on the staged ones', async () => {
      const { world, visited, deps } = await threeCompanies()
      const now = world.now()
      world.db.seed('pending_operations', [
        // Today's batch, already approved: nothing more to do for company-a today.
        { id: 'op-a', company_id: 'company-a', operation_type: COLLECTIONS_BATCH_TYPE, status: 'committed', params: { batch_date: todayIsoStockholm(now) }, created_at: new Date(now.getTime() - 3_600_000).toISOString() },
        // Yesterday's, done: company-c still needs today's.
        { id: 'op-c', company_id: 'company-c', operation_type: COLLECTIONS_BATCH_TYPE, status: 'committed', params: { batch_date: '2000-01-01' }, created_at: new Date(now.getTime() - 26 * 3_600_000).toISOString() },
      ])
      const summary = await runLadderCron(deps({ deadlineMs: 120_000 }))
      expect(visited).toEqual(['company-b', 'company-c'])
      expect(summary.notReached).toBe(1)
    })

    it('runs in plain order when the order lookup fails', async () => {
      const { world, visited, logger, deps } = await threeCompanies()
      // The expiry sweep is an update; the only read here is the order lookup (the companies are gated).
      world.db.failures.set('pending_operations:select', { message: 'down' })
      await runLadderCron(deps())
      expect(visited).toEqual(['company-a', 'company-b', 'company-c'])
      expect(logger.warn).toHaveBeenCalledWith('collections batch order lookup failed; companies run in plain order', { error: 'down' })
    })
  })
})
