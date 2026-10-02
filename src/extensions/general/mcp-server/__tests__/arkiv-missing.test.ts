import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { arkivMissingResource } from '../resources/arkiv-missing'

const mock = createQueuedMockSupabase()
const { enqueue, reset } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ctx = { supabase, companyId: CO, userId: 'user-1', scopes: [] as never[] }

beforeEach(() => {
  reset()
  process.env.ARKIV_BRAIN_COMPANY_IDS = CO
  process.env.RESEND_INBOUND_DOMAIN = 'in.accounted.se'
})
afterEach(() => {
  delete process.env.ARKIV_BRAIN_COMPANY_IDS
  delete process.env.RESEND_INBOUND_DOMAIN
})

describe('Accounted://arkiv/missing', () => {
  it('lists what the books expect with its evidence, the hint, and the address to forward to', async () => {
    enqueue({ data: [{ id: 'f-1', key: 'document_expected:loan', detail: { rule: 'loan', expected_type: 'agreement.loan', evidence: { cost_months: 3, cost_total: 13875, accounts: ['8410'] } }, first_seen_at: '2026-09-17T04:10:00Z' }] })
    enqueue({ data: { local_part: 'arcim-7f3k' } })
    const out = (await arkivMissingResource.read(ctx)) as { intake: { email: string | null }; missing: Array<Record<string, unknown>>; how_to: string[] }
    expect(out.intake.email).toBe('arcim-7f3k@in.accounted.se')
    expect(out.missing).toEqual([
      expect.objectContaining({ finding_id: 'f-1', rule: 'loan', expected_type: 'agreement.loan', label: 'Låneavtal', since: '2026-09-17T04:10:00Z' }),
    ])
    expect(String(out.missing[0].hint)).toContain('Skuldebrev')
    expect(out.how_to.join(' ')).toContain('gnubok_resolve_missing')
  })

  it('has no address without an inbox or a domain, and is off outside the rollout', async () => {
    delete process.env.RESEND_INBOUND_DOMAIN
    enqueue({ data: [] })
    enqueue({ data: { local_part: 'x' } })
    const out = (await arkivMissingResource.read(ctx)) as { intake: { email: string | null }; missing: unknown[] }
    expect(out).toMatchObject({ intake: { email: null }, missing: [] })
    process.env.ARKIV_BRAIN_COMPANY_IDS = 'someone-else'
    expect(await arkivMissingResource.read(ctx)).toMatchObject({ enabled: false })
  })
})
