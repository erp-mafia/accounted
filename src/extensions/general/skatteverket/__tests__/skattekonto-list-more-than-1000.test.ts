import { describe, it, expect, vi } from 'vitest'
import { createPagedMockSupabase, manyRows } from '@/tests/helpers'
import { skatteverketExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * GET /skattekonto/transaktioner reads every row of the skattekonto, not
 * PostgREST's first 1,000 (max-rows): past that the oldest rows fell out of
 * every bucket.
 */

function findRoute() {
  const route = skatteverketExtension.apiRoutes?.find(
    (r) => r.method === 'GET' && r.path === '/skattekonto/transaktioner',
  )
  if (!route) throw new Error('list route not registered')
  return route
}

describe('GET /skattekonto/transaktioner past 1,000 rows', () => {
  it('counts every row, paged on transaktionsdatum then id', async () => {
    const { supabase, findCalls } = createPagedMockSupabase({
      skattekonto_transactions: manyRows(1001, (i) => ({
        id: `row-${i}`,
        transaktionsdatum: '2026-09-12',
        forfallodatum: null,
        transaktionstext: 'Debiterad preliminärskatt',
        belopp_skatteverket: -1000,
        status: 'unbooked',
        is_ignored: true,
        journal_entry_id: null,
      })),
    })
    const ctx = {
      userId: 'user-1',
      companyId: 'company-1',
      extensionId: 'skatteverket',
      requestId: 'req_test',
      supabase,
      emit: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
      settings: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
    } as unknown as ExtensionContext

    const res = await findRoute().handler(
      new Request('http://localhost/api/extensions/ext/skatteverket/skattekonto/transaktioner'),
      ctx,
    )
    const body = (await res.json()) as { data: { ignored_count: number } }

    expect(res.status).toBe(200)
    expect(body.data.ignored_count).toBe(1001)
    expect(findCalls('skattekonto_transactions', 'order').map((a) => a[0]).slice(0, 2)).toEqual(['transaktionsdatum', 'id'])
  })
})
