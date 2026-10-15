/**
 * The engine doors to the SQL functions that post a verifikat outside
 * commitEntry: match_batch_allocate, create_expense_payout_batch,
 * link_invoice_to_voucher and link_supplier_invoice_to_voucher. Each RPC
 * inserts, numbers and commits its verifikat through commit_journal_entry in
 * SQL, so the door is what announces it with journal_entry.committed (the
 * event webhook subscribers and the event log listen to). Before the doors,
 * every one of these vouchers was posted without the event.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

const emit = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/events', () => ({
  eventBus: { emit: (...args: unknown[]) => emit(...args) },
}))

vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: vi.fn().mockResolvedValue([]),
}))

const { runWithActor } = await import('@/lib/bookkeeping/actor-context-node')
const {
  commitMatchBatchAllocation,
  commitExpensePayoutBatch,
  commitInvoiceVoucherLink,
  commitSupplierInvoiceVoucherLink,
} = await import('../engine')

type Result = { data?: unknown; error?: unknown }

const POSTED = {
  id: 'je-new',
  company_id: 'co',
  status: 'posted',
  voucher_series: 'A',
  voucher_number: 21,
  lines: [
    { account_number: '1930', debit_amount: 1250, credit_amount: 0 },
    { account_number: '1510', debit_amount: 0, credit_amount: 1250 },
  ],
}

function makeSupabase(rpc: Result, reload: Result = { data: POSTED }) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const chain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve({ data: reload.data ?? null, error: reload.error ?? null })
          }
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args })
            return chain(table)
          }
        },
      },
    )
  const rpcFn = vi.fn().mockResolvedValue({ data: rpc.data ?? null, error: rpc.error ?? null })
  const supabase = { rpc: rpcFn, from: vi.fn((table: string) => chain(table)) }
  return { supabase: supabase as never, rpc: rpcFn, calls }
}

interface Door {
  name: string
  rpcName: string
  call: (supabase: never) => Promise<{ data: unknown; error: unknown }>
  rpcArgs: Record<string, unknown>
  /** The RPC's success answer that posted POSTED. */
  posted: Record<string, unknown>
  refusal: Record<string, unknown>
}

const DOORS: Door[] = [
  {
    name: 'commitMatchBatchAllocation',
    rpcName: 'match_batch_allocate',
    call: (supabase) =>
      commitMatchBatchAllocation(supabase, 'co', 'user-1', {
        transactionId: 'tx-1',
        allocations: [{ kind: 'customer_invoice', invoice_id: 'inv-1', amount: 1250 }],
      }),
    rpcArgs: {
      p_tx_id: 'tx-1',
      p_allocations: [{ kind: 'customer_invoice', invoice_id: 'inv-1', amount: 1250 }],
      p_company_id: 'co',
      p_user_id: 'user-1',
    },
    posted: { ok: true, journal_entry_id: 'je-new', voucher_series: 'A', voucher_number: 21, allocations: [] },
    refusal: { ok: false, code: 'BATCH_OVER_ALLOCATED' },
  },
  {
    name: 'commitExpensePayoutBatch',
    rpcName: 'create_expense_payout_batch',
    call: (supabase) =>
      commitExpensePayoutBatch(supabase, 'co', 'user-1', {
        claimIds: ['c1', 'c2'],
        payoutDate: '2026-09-10',
        cashAccount: '1930',
        notes: null,
        transactionId: 'tx-1',
      }),
    rpcArgs: {
      p_company_id: 'co',
      p_claim_ids: ['c1', 'c2'],
      p_payout_date: '2026-09-10',
      p_cash_account: '1930',
      p_notes: null,
      p_user_id: 'user-1',
      p_transaction_id: 'tx-1',
    },
    posted: { ok: true, batch_id: 'b1', journal_entry_id: 'je-new', voucher_number: 21, total_sek: 1250, claim_count: 2 },
    refusal: { ok: false, code: 'ALREADY_PAID' },
  },
  {
    name: 'commitInvoiceVoucherLink',
    rpcName: 'link_invoice_to_voucher',
    call: (supabase) =>
      commitInvoiceVoucherLink(supabase, 'co', 'user-1', { invoiceId: 'inv-1', journalEntryId: 'je-pay', notes: null }),
    rpcArgs: {
      p_invoice_id: 'inv-1',
      p_journal_entry_id: 'je-pay',
      p_user_id: 'user-1',
      p_company_id: 'co',
      p_notes: null,
    },
    // A EUR invoice settled at another rate: the kursdifferens verifikat.
    posted: { ok: true, journal_entry_id: 'je-pay', fx_journal_entry_id: 'je-new', fx_voucher_number: 21 },
    refusal: { ok: false, code: 'LINK_VOUCHER_ALREADY_LINKED' },
  },
  {
    name: 'commitSupplierInvoiceVoucherLink',
    rpcName: 'link_supplier_invoice_to_voucher',
    call: (supabase) =>
      commitSupplierInvoiceVoucherLink(supabase, 'co', 'user-1', {
        supplierInvoiceId: 'si-1',
        journalEntryId: 'je-pay',
        notes: 'Auto-länkad',
      }),
    rpcArgs: {
      p_supplier_invoice_id: 'si-1',
      p_journal_entry_id: 'je-pay',
      p_user_id: 'user-1',
      p_company_id: 'co',
      p_notes: 'Auto-länkad',
    },
    posted: { ok: true, journal_entry_id: 'je-pay', fx_journal_entry_id: 'je-new', fx_voucher_number: 21 },
    refusal: { ok: false, code: 'LINK_SI_VOUCHER_ALREADY_LINKED' },
  },
]

beforeEach(() => {
  vi.clearAllMocks()
})

// The supplier link's stated share (GitHub issue 3490). The five-argument
// call above is the one a link without a share makes, so it reads the same
// against a database that does not have the six-argument function yet.
describe('commitSupplierInvoiceVoucherLink: the stated share', () => {
  it('sends p_amount when a share is stated', async () => {
    const { supabase, rpc } = makeSupabase({ data: { ok: true, journal_entry_id: 'je-pay', voucher_remaining: 4000 } })

    await commitSupplierInvoiceVoucherLink(supabase, 'co', 'user-1', {
      supplierInvoiceId: 'si-1',
      journalEntryId: 'je-pay',
      notes: null,
      amount: 1250,
    })

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('link_supplier_invoice_to_voucher', {
      p_supplier_invoice_id: 'si-1',
      p_journal_entry_id: 'je-pay',
      p_user_id: 'user-1',
      p_company_id: 'co',
      p_notes: null,
      p_amount: 1250,
    })
  })

  it('leaves p_amount out when the share is null or absent', async () => {
    for (const amount of [null, undefined]) {
      const { supabase, rpc } = makeSupabase({ data: { ok: true, journal_entry_id: 'je-pay' } })

      await commitSupplierInvoiceVoucherLink(supabase, 'co', 'user-1', {
        supplierInvoiceId: 'si-1',
        journalEntryId: 'je-pay',
        notes: null,
        amount,
      })

      expect(rpc).toHaveBeenCalledWith('link_supplier_invoice_to_voucher', {
        p_supplier_invoice_id: 'si-1',
        p_journal_entry_id: 'je-pay',
        p_user_id: 'user-1',
        p_company_id: 'co',
        p_notes: null,
      })
    }
  })
})

describe.each(DOORS)('$name', (door) => {
  it('announces the verifikat the RPC posted with journal_entry.committed, as commitEntry does', async () => {
    const { supabase, rpc, calls } = makeSupabase({ data: door.posted })

    const result = await door.call(supabase)

    expect(result).toEqual({ data: door.posted, error: null })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith(door.rpcName, door.rpcArgs)
    // The reload is scoped to the entry AND the company.
    const reload = calls.filter((c) => c.table === 'journal_entries')
    expect(reload.find((c) => c.method === 'select')?.args).toEqual(['*, lines:journal_entry_lines(*)'])
    expect(reload.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([
      ['id', 'je-new'],
      ['company_id', 'co'],
    ])
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({
      type: 'journal_entry.committed',
      payload: { entry: POSTED, userId: 'user-1', companyId: 'co' },
    })
  })

  it('a structured refusal posts nothing: returned unchanged, nothing announced', async () => {
    const { supabase, calls } = makeSupabase({ data: door.refusal })

    const result = await door.call(supabase)

    expect(result).toEqual({ data: door.refusal, error: null })
    expect(calls).toHaveLength(0)
    expect(emit).not.toHaveBeenCalled()
  })

  it('a transport error is returned unchanged and announces nothing', async () => {
    const pgError = { message: 'connection reset', code: '08006' }
    const { supabase, calls } = makeSupabase({ error: pgError })

    const result = await door.call(supabase)

    expect(result.error).toEqual(pgError)
    expect(calls).toHaveLength(0)
    expect(emit).not.toHaveBeenCalled()
  })

  it('a failed reload after the commit still answers the operation, without the event', async () => {
    const { supabase } = makeSupabase({ data: door.posted }, { error: { message: 'timeout' } })

    const result = await door.call(supabase)

    expect(result).toEqual({ data: door.posted, error: null })
    expect(emit).not.toHaveBeenCalled()
  })
})

describe.each(DOORS.filter((d) => d.rpcName.startsWith('link_')))('$name without a kursdifferens', (door) => {
  it('posts no verifikat, so reloads and announces nothing: the linked voucher was announced when posted', async () => {
    const linked = { ...door.posted, fx_journal_entry_id: null, fx_voucher_number: null }
    const { supabase, calls } = makeSupabase({ data: linked })

    const result = await door.call(supabase)

    expect(result).toEqual({ data: linked, error: null })
    expect(calls).toHaveLength(0)
    expect(emit).not.toHaveBeenCalled()
  })
})

// WHO posted the verifikat (migration 20261016005100): each door hands the
// actor of the surrounding scope to its RPC, which forwards it to
// commit_journal_entry. A database without the migration answers PGRST202,
// and the door retries once without the actor instead of failing.
describe.each(DOORS)('$name: the actor', (door) => {
  it('sends the actor of the current scope beside the RPC arguments', async () => {
    const { supabase, rpc } = makeSupabase({ data: door.posted })

    await runWithActor({ type: 'api_key', label: 'Bokföringsagent' }, () => door.call(supabase))

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith(door.rpcName, {
      ...door.rpcArgs,
      p_actor_type: 'api_key',
      p_actor_label: 'Bokföringsagent',
    })
  })

  it('retries once without the actor when the database predates it, and still announces the verifikat', async () => {
    const { supabase, rpc } = makeSupabase({ data: door.posted })
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST202', message: `Could not find the function public.${door.rpcName} in the schema cache` },
    })

    const result = await runWithActor({ type: 'user' }, () => door.call(supabase))

    expect(result).toEqual({ data: door.posted, error: null })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenNthCalledWith(1, door.rpcName, { ...door.rpcArgs, p_actor_type: 'user', p_actor_label: null })
    expect(rpc).toHaveBeenNthCalledWith(2, door.rpcName, door.rpcArgs)
    expect(emit).toHaveBeenCalledTimes(1)
  })
})
