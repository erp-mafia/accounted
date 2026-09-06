import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The count the cron sizes and orders its run by. It must be the pass's own
 * predicate (non-draft sales invoices of this company with no rows) evaluated
 * in the database as a HEAD count, so a company with thousands of complete
 * invoices costs one indexed query and no rows. The grammar itself
 * (`invoice_items=is.null` on a to-many embed) is proven against a real
 * PostgREST in complete-invoice-lines-count.tool.test.ts; this file pins the
 * query shape and the error contract.
 */

vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: vi.fn() }))
vi.mock('@/lib/providers/provider-data-fetcher', () => ({
  fetchSalesInvoicesDirect: vi.fn(),
  hydrateSalesInvoices: vi.fn(),
}))
vi.mock('@/lib/supabase/fetch-all', () => ({ fetchAllRows: vi.fn() }))

import { countRowlessInvoices } from '../complete-invoice-lines'

interface Call { method: string; args: unknown[] }

/** Thenable query-builder stand-in that records the chain and answers with `response`. */
function makeSupabase(response: { count: number | null; error: { message: string } | null }) {
  const calls: Call[] = []
  const tables: string[] = []
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'neq', 'is']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return builder
    }
  }
  builder.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(response).then(resolve, reject)
  const from = vi.fn((table: string) => {
    tables.push(table)
    return builder
  })
  return { supabase: { from } as unknown as SupabaseClient, calls, tables }
}

describe('countRowlessInvoices', () => {
  it('counts non-draft sales invoices with no rows in the database, loading none of them', async () => {
    const { supabase, calls, tables } = makeSupabase({ count: 155, error: null })

    await expect(countRowlessInvoices(supabase, 'co-1')).resolves.toBe(155)

    expect(tables).toEqual(['invoices'])
    expect(calls).toEqual([
      { method: 'select', args: ['id, invoice_items(id)', { count: 'exact', head: true }] },
      { method: 'eq', args: ['company_id', 'co-1'] },
      { method: 'eq', args: ['document_type', 'invoice'] },
      { method: 'neq', args: ['status', 'draft'] },
      { method: 'is', args: ['invoice_items', null] },
    ])
  })

  it('throws on a failed count rather than reporting the company as done', async () => {
    const { supabase } = makeSupabase({ count: null, error: { message: 'canceling statement due to statement timeout' } })

    await expect(countRowlessInvoices(supabase, 'co-1')).rejects.toThrow(
      'invoices count failed: canceling statement due to statement timeout',
    )
  })

  it('reads a missing count as nothing to do', async () => {
    const { supabase } = makeSupabase({ count: null, error: null })

    await expect(countRowlessInvoices(supabase, 'co-1')).resolves.toBe(0)
  })
})
