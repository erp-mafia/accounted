/**
 * The attest gate (../payment-attest-gate.ts) against payments' contract
 * (lib/payments/attest-gate.ts):
 *   - owned by supplier invoices, frozen;
 *   - it calls loadAttestBlockedInvoiceIds unchanged, with the arguments the
 *     payment paths passed before the gate existed, and hands back its answer
 *     and its throw as they are;
 *   - cycle guard: neither the gate nor its leaf reaches back into payments,
 *     engine.ts or lib/init.
 * The behaviour of both payment paths under the policy is pinned by
 * lib/payments/__tests__/batch-attest.test.ts and
 * lib/payments/orders/__tests__/prepare-lifecycle.test.ts.
 */
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const leaf = vi.hoisted(() => ({ loadAttestBlockedInvoiceIds: vi.fn() }))
vi.mock('@/lib/supplier-invoices/attest-policy-read', () => ({
  loadAttestBlockedInvoiceIds: leaf.loadAttestBlockedInvoiceIds,
}))

import { PAYMENT_ATTEST_GATE } from '../payment-attest-gate'
import { MODULE_IDS } from '@/lib/modules/manifest'
import { moduleForLibPath } from '@/lib/modules/resolve'
import { scanLibImports } from '@/lib/modules/__tests__/import-scan'

const LIB_ROOT = join(__dirname, '..', '..')
const LEAF = 'supplier-invoices/attest-policy-read'

describe('PAYMENT_ATTEST_GATE', () => {
  beforeEach(() => {
    leaf.loadAttestBlockedInvoiceIds.mockReset()
  })

  it('is the supplier invoice attest policy, owned by the module of its leaf, and frozen', () => {
    expect(PAYMENT_ATTEST_GATE.id).toBe('supplier-invoice-attest-policy')
    expect(PAYMENT_ATTEST_GATE.module).toBe('supplier-invoices')
    expect(MODULE_IDS).toContain(PAYMENT_ATTEST_GATE.module)
    expect(moduleForLibPath(LEAF)).toBe(PAYMENT_ATTEST_GATE.module)
    expect(Object.isFrozen(PAYMENT_ATTEST_GATE)).toBe(true)
  })

  it('calls loadAttestBlockedInvoiceIds once with the same arguments and returns its set as it is', async () => {
    const supabase = {} as SupabaseClient
    const ids = ['a', 'b']
    const blocked = new Set(['a'])
    leaf.loadAttestBlockedInvoiceIds.mockResolvedValue(blocked)

    await expect(PAYMENT_ATTEST_GATE.blockedInvoiceIds(supabase, 'company-1', ids)).resolves.toBe(blocked)
    expect(leaf.loadAttestBlockedInvoiceIds).toHaveBeenCalledTimes(1)
    expect(leaf.loadAttestBlockedInvoiceIds).toHaveBeenCalledWith(supabase, 'company-1', ids)
    expect(leaf.loadAttestBlockedInvoiceIds.mock.calls[0]![2]).toBe(ids)
  })

  it('passes a failed read on as it is: payment never reads it as no policy', async () => {
    const failed = new Error('policy read failed')
    leaf.loadAttestBlockedInvoiceIds.mockRejectedValue(failed)
    await expect(PAYMENT_ATTEST_GATE.blockedInvoiceIds({} as SupabaseClient, 'company-1', ['a'])).rejects.toBe(failed)
  })
})

describe('payment attest gate: cycle guard', () => {
  const edges = scanLibImports(LIB_ROOT)
  const files = new Set(edges.map((edge) => edge.from.replace(/\.tsx?$/, '')))
  const graph = new Map<string, string[]>()
  for (const edge of edges) {
    const from = edge.from.replace(/\.tsx?$/, '')
    const to = files.has(edge.to) ? edge.to : files.has(`${edge.to}/index`) ? `${edge.to}/index` : edge.to
    graph.set(from, [...(graph.get(from) ?? []), to])
  }
  const reaches = (start: string, target: (node: string) => boolean): string[] | null => {
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

  it('sees a real path (control: the payment file reaches the gate)', () => {
    expect(reaches('payments/batch-service', (node) => node === 'composition/payment-attest-gate')).not.toBeNull()
  })

  it.each([LEAF, 'composition/payment-attest-gate'])('%s never reaches payments, engine.ts or lib/init', (start) => {
    expect(reaches(start, (node) => node.startsWith('payments/')), 'path to lib/payments').toBeNull()
    expect(reaches(start, (node) => node === 'bookkeeping/engine'), 'path to engine.ts').toBeNull()
    expect(reaches(start, (node) => node === 'init' || node === 'init/index'), 'path to lib/init').toBeNull()
  })
})
