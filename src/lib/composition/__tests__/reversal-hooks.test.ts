/**
 * The reversal hook list (../reversal-hooks.ts) against the ledger's
 * contract (lib/bookkeeping/reversal-hooks.ts):
 *   - completeness: every source type that needs a mirror has a hook, every
 *     hook covers only such types, at most one beforeReversal per type;
 *   - ownership: hook.module is the module that owns the leaf the hook calls;
 *   - each hook calls its leaf function unchanged, with the arguments
 *     engine.ts passed before the list existed;
 *   - the known gap: source types that carry sub-ledger state but have no
 *     hook today are listed by name, so the gap stays visible;
 *   - cycle guard: no hook leaf reaches engine.ts or lib/init.
 */
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JournalEntry, JournalEntrySourceType } from '@/types'

const leaves = vi.hoisted(() => ({
  syncInvoiceStatusFromPaymentEntry: vi.fn(async () => {}),
  syncRotRutReclaimAfterReversal: vi.fn(async () => {}),
  assertMigratedDeductionReversible: vi.fn(async () => {}),
  syncMigratedDeductionAfterReversal: vi.fn(async () => {}),
  releaseSettlementAfterReversal: vi.fn(async () => ({ released: true })),
  assertCustomerLossReversible: vi.fn(async () => {}),
  syncCustomerLossAfterReversal: vi.fn(async () => {}),
}))

vi.mock('@/lib/bookkeeping/payment-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/payment-sync')>()),
  syncInvoiceStatusFromPaymentEntry: leaves.syncInvoiceStatusFromPaymentEntry,
}))
vi.mock('@/lib/invoices/rot-rut-reclaim-reversal', () => ({
  syncRotRutReclaimAfterReversal: leaves.syncRotRutReclaimAfterReversal,
}))
vi.mock('@/lib/invoices/migrated-deduction-reversal', () => ({
  assertMigratedDeductionReversible: leaves.assertMigratedDeductionReversible,
  syncMigratedDeductionAfterReversal: leaves.syncMigratedDeductionAfterReversal,
}))
vi.mock('@/lib/collections/settlement-reversal', () => ({
  releaseSettlementAfterReversal: leaves.releaseSettlementAfterReversal,
}))
vi.mock('@/lib/customer-loss/reversal', () => ({
  assertCustomerLossReversible: leaves.assertCustomerLossReversible,
  syncCustomerLossAfterReversal: leaves.syncCustomerLossAfterReversal,
}))

import { REVERSAL_HOOKS } from '../reversal-hooks'
import { REVERSAL_MIRROR_REQUIRED, type ReversalHookAfterContext } from '@/lib/bookkeeping/reversal-hooks'
import { PAYMENT_SOURCE_TYPES } from '@/lib/bookkeeping/payment-sync'
import { moduleForLibPath } from '@/lib/modules/resolve'
import { scanLibImports } from '@/lib/modules/__tests__/import-scan'

const LIB_ROOT = join(__dirname, '..', '..')

/**
 * The leaf module (path under src/lib) each hook calls into. A new hook
 * names its leaf here; the ownership and cycle tests below read it.
 */
const HOOK_LEAVES: Record<string, string> = {
  'invoice-payment-status': 'bookkeeping/payment-sync',
  'rot-rut-reclaim': 'invoices/rot-rut-reclaim-reversal',
  'migrated-deduction': 'invoices/migrated-deduction-reversal',
  'collections-payout': 'collections/settlement-reversal',
  'customer-loss': 'customer-loss/reversal',
}

/**
 * Source types whose voucher carries sub-ledger state that a storno leaves
 * as it is: no reversal hook mirrors them today. Listed so the gap is
 * visible; adding a hook for one moves it to REVERSAL_MIRROR_REQUIRED (the
 * test below fails until it is taken off this list).
 */
const KNOWN_UNMIRRORED: Partial<Record<JournalEntrySourceType, string>> = {
  rot_rut_payout: 'rot_rut_payout_requests.settlement_journal_entry_id',
  expense_payout: 'expense_payout_batches.journal_entry_id, expense_claims.status paid',
  salary_payment: 'salary_runs.status booked (vouchers found by source_id = run id)',
  pos_daily_sales: 'pos_sales_days.journal_entry_id',
  stripe_payout: 'stripe_payouts.journal_entry_id, status booked',
  webshop_order: 'webshop_orders.journal_entry_id',
  invoice_created: 'invoices.journal_entry_id',
  credit_note: 'invoices.journal_entry_id (the credit note row)',
  supplier_invoice_registered: 'supplier_invoices.registration_journal_entry_id',
  supplier_credit_note: 'supplier_invoices.registration_journal_entry_id (the credit note row)',
  expense_claim: 'expense_claims.journal_entry_id',
  accrual: 'accrual_schedule_installments.journal_entry_id, status posted',
}

const covered = (sourceType: string) =>
  REVERSAL_HOOKS.filter((hook) => (hook.sourceTypes as readonly string[]).includes(sourceType))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('reversal hook list: completeness', () => {
  it('covers every source type in REVERSAL_MIRROR_REQUIRED', () => {
    const missing = REVERSAL_MIRROR_REQUIRED.filter((type) => covered(type).length === 0)
    expect(missing).toEqual([])
  })

  it('covers only required source types (a type with a hook is a type that must have one)', () => {
    const extra = REVERSAL_HOOKS.flatMap((hook) => hook.sourceTypes).filter(
      (type) => !REVERSAL_MIRROR_REQUIRED.includes(type),
    )
    expect(extra).toEqual([])
  })

  it('runs at most one beforeReversal and at most one hook per source type', () => {
    for (const type of REVERSAL_MIRROR_REQUIRED) {
      expect(covered(type).filter((hook) => hook.beforeReversal).length, type).toBeLessThanOrEqual(1)
      expect(covered(type).length, type).toBe(1)
    }
  })

  it('gives every hook a unique kebab-case id, at least one source type and at least one phase', () => {
    const ids = REVERSAL_HOOKS.map((hook) => hook.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const hook of REVERSAL_HOOKS) {
      expect(hook.id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
      expect(hook.sourceTypes.length, hook.id).toBeGreaterThan(0)
      expect(Boolean(hook.beforeReversal || hook.afterReversal), hook.id).toBe(true)
    }
  })

  it('keeps the payment hook on exactly the payment source types', () => {
    const payment = REVERSAL_HOOKS.find((hook) => hook.id === 'invoice-payment-status')
    expect(payment?.sourceTypes).toEqual([...PAYMENT_SOURCE_TYPES])
  })

  it('lists the known unmirrored source types apart from the mirrored ones', () => {
    for (const type of Object.keys(KNOWN_UNMIRRORED) as JournalEntrySourceType[]) {
      expect(REVERSAL_MIRROR_REQUIRED.includes(type), `${type} has a hook: take it off KNOWN_UNMIRRORED`).toBe(false)
      expect(covered(type), type).toEqual([])
    }
  })
})

describe('reversal hook list: ownership', () => {
  it('names a leaf for every hook, and the composition file imports exactly those leaves', () => {
    expect(Object.keys(HOOK_LEAVES).sort()).toEqual(REVERSAL_HOOKS.map((hook) => hook.id).sort())
    const imported = scanLibImports(LIB_ROOT)
      .filter((edge) => edge.from === 'composition/reversal-hooks.ts')
      .map((edge) => edge.to)
      .sort()
    expect(imported).toEqual([...new Set(Object.values(HOOK_LEAVES))].sort())
  })

  it('declares as hook.module the module that owns the leaf the hook calls', () => {
    for (const hook of REVERSAL_HOOKS) {
      expect(hook.module, hook.id).toBe(moduleForLibPath(HOOK_LEAVES[hook.id]))
    }
  })
})

describe('reversal hook list: each hook wraps its function unchanged', () => {
  const supabase = { sentinel: 'client' }
  const entry = { id: 'entry-1', source_type: 'invoice_paid', source_id: 'invoice-1', lines: [] } as unknown as JournalEntry
  const storno = { id: 'storno-1', entry_date: '2026-10-20' }
  const ctx = { supabase, companyId: 'company-1', userId: 'user-1', entry, storno } as unknown as ReversalHookAfterContext
  const hook = (id: string) => REVERSAL_HOOKS.find((h) => h.id === id)!

  it('invoice-payment-status: after only, syncInvoiceStatusFromPaymentEntry(supabase, companyId, entry)', async () => {
    expect(hook('invoice-payment-status').beforeReversal).toBeUndefined()
    await hook('invoice-payment-status').afterReversal!(ctx)
    expect(leaves.syncInvoiceStatusFromPaymentEntry).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', entry)
  })

  it('invoice-payment-status: the collections rebook storno leaves the collected payment rows to the rebook', async () => {
    await hook('invoice-payment-status').afterReversal!({ ...ctx, leaveCollectedPaymentRows: true })
    expect(leaves.syncInvoiceStatusFromPaymentEntry).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', entry, undefined, {
      leaveCollectedPaymentRows: true,
    })
  })

  it('rot-rut-reclaim: after only, syncRotRutReclaimAfterReversal(supabase, companyId, entry.id)', async () => {
    expect(hook('rot-rut-reclaim').beforeReversal).toBeUndefined()
    await hook('rot-rut-reclaim').afterReversal!(ctx)
    expect(leaves.syncRotRutReclaimAfterReversal).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', 'entry-1')
  })

  it('migrated-deduction: assertMigratedDeductionReversible before, syncMigratedDeductionAfterReversal after', async () => {
    await hook('migrated-deduction').beforeReversal!(ctx)
    expect(leaves.assertMigratedDeductionReversible).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', entry)
    expect(leaves.syncMigratedDeductionAfterReversal).not.toHaveBeenCalled()
    await hook('migrated-deduction').afterReversal!(ctx)
    expect(leaves.syncMigratedDeductionAfterReversal).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', entry)
  })

  it('collections-payout: after only, releaseSettlementAfterReversal(companyId, entry.id)', async () => {
    expect(hook('collections-payout').beforeReversal).toBeUndefined()
    await hook('collections-payout').afterReversal!(ctx)
    expect(leaves.releaseSettlementAfterReversal).toHaveBeenCalledExactlyOnceWith('company-1', 'entry-1')
  })

  it('customer-loss: assertCustomerLossReversible before, syncCustomerLossAfterReversal with the actor and the storno after', async () => {
    await hook('customer-loss').beforeReversal!(ctx)
    expect(leaves.assertCustomerLossReversible).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', 'entry-1')
    expect(leaves.syncCustomerLossAfterReversal).not.toHaveBeenCalled()
    await hook('customer-loss').afterReversal!(ctx)
    expect(leaves.syncCustomerLossAfterReversal).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', 'user-1', 'entry-1', storno)
  })

  it('passes a leaf refusal through untouched', async () => {
    const refusal = { message: 'connection reset' }
    leaves.assertMigratedDeductionReversible.mockRejectedValueOnce(refusal)
    await expect(hook('migrated-deduction').beforeReversal!(ctx)).rejects.toBe(refusal)
  })
})

describe('reversal hook list: cycle guard', () => {
  // Every runtime import under src/lib (static and dynamic), as a graph of
  // module paths without extension.
  const edges = scanLibImports(LIB_ROOT)
  const files = new Set(edges.map((edge) => edge.from.replace(/\.tsx?$/, '')))
  const graph = new Map<string, string[]>()
  for (const edge of edges) {
    const from = edge.from.replace(/\.tsx?$/, '')
    const to = files.has(edge.to) ? edge.to : files.has(`${edge.to}/index`) ? `${edge.to}/index` : edge.to
    graph.set(from, [...(graph.get(from) ?? []), to])
  }
  const pathTo = (start: string, target: (node: string) => boolean): string[] | null => {
    const parent = new Map<string, string | null>([[start, null]])
    const queue = [start]
    while (queue.length > 0) {
      const node = queue.shift()!
      if (target(node)) {
        const path = [node]
        for (let p = parent.get(node); p; p = parent.get(p)) path.unshift(p)
        return path
      }
      for (const next of graph.get(node) ?? []) {
        if (!parent.has(next)) {
          parent.set(next, node)
          queue.push(next)
        }
      }
    }
    return null
  }

  it('sees a real path (control: the reclaim service reaches engine.ts through the entries builder)', () => {
    expect(pathTo('invoices/rot-rut-reclaim', (node) => node === 'bookkeeping/engine')).not.toBeNull()
  })

  it.each([...new Set(Object.values(HOOK_LEAVES)), 'composition/reversal-hooks'])(
    '%s never reaches engine.ts or lib/init',
    (start) => {
      expect(pathTo(start, (node) => node === 'bookkeeping/engine'), 'path to engine.ts').toBeNull()
      expect(pathTo(start, (node) => node === 'init' || node === 'init/index'), 'path to lib/init').toBeNull()
    },
  )
})
