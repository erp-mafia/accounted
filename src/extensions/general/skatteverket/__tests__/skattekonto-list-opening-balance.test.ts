import { describe, it, expect, vi } from 'vitest'
import { createPagedMockSupabase } from '@/tests/helpers'
import { skatteverketExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * GET /skattekonto/transaktioner reports the date of the ingående balans on
 * the skattekonto account, so the Transaktioner inbox and the skattekonto
 * page leave out the unbooked rows that IB carries, as Att göra does
 * (crm#2010).
 */

function findRoute() {
  const route = skatteverketExtension.apiRoutes?.find(
    (r) => r.method === 'GET' && r.path === '/skattekonto/transaktioner',
  )
  if (!route) throw new Error('list route not registered')
  return route
}

function context(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    requestId: 'req_test',
    supabase,
    emit: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    settings: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
  } as unknown as ExtensionContext
}

const row = (id: string, transaktionsdatum: string) => ({
  id,
  transaktionsdatum,
  forfallodatum: null,
  ranteberakningsdatum: null,
  transaktionstext: 'Intäktsränta',
  belopp_skatteverket: 12,
  status: 'booked',
  is_ignored: false,
  journal_entry_id: null,
})

async function list(tables: Record<string, unknown[]>) {
  const { supabase, findCalls } = createPagedMockSupabase({
    company_settings: [{ entity_type: 'aktiebolag', employer_registered: false, pays_salaries: false }],
    ...tables,
  })
  const res = await findRoute().handler(
    new Request('http://localhost/api/extensions/ext/skatteverket/skattekonto/transaktioner'),
    context(supabase),
  )
  const body = (await res.json()) as { data: { booked: { id: string }[]; opening_balance_date: string | null } }
  return { res, body, findCalls }
}

describe('GET /skattekonto/transaktioner: the opening balance date', () => {
  it('reports the date of the latest IB on the skattekonto account and still lists every row', async () => {
    const { res, body, findCalls } = await list({
      skattekonto_transactions: [row('carried', '2026-08-26'), row('open', '2026-11-03')],
      'rpc:account_ib_floor': [{ floor_date: '2026-09-01', amount: 5000, entry_ids: ['ib-1'] }],
    })
    expect(res.status).toBe(200)
    expect(body.data.opening_balance_date).toBe('2026-09-01')
    expect(body.data.booked.map((r) => r.id).sort()).toEqual(['carried', 'open'])
    expect(findCalls('rpc:account_ib_floor', 'rpc')[0][0]).toMatchObject({ p_company_id: 'company-1', p_account_number: '1630' })
  })

  it('reports null without an IB on the account', async () => {
    const { body } = await list({ skattekonto_transactions: [row('open', '2026-11-03')] })
    expect(body.data.opening_balance_date).toBeNull()
  })

  it('reads no IB when there is no carried-out row to date', async () => {
    const { body, findCalls } = await list({ skattekonto_transactions: [] })
    expect(body.data.opening_balance_date).toBeNull()
    expect(findCalls('rpc:account_ib_floor', 'rpc')).toEqual([])
  })
})
