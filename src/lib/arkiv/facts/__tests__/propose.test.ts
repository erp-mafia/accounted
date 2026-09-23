import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/documents/provenance', () => ({ softwareAgent: vi.fn(async () => 'agent-mcp') }))

import { commitArkivProposeFact } from '../propose'

const mock = createQueuedMockSupabase()
const { enqueue, reset } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const rpc = mock.supabase.rpc

const AGR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

beforeEach(() => {
  reset()
  rpc.mockClear()
})

describe('commitArkivProposeFact', () => {
  it('refuses bad params, unknown predicates and predicates of another subject', async () => {
    expect(await commitArkivProposeFact(supabase, 'user-1', 'co-1', { subject_kind: 'company' })).toMatchObject({ status: 400 })
    expect(await commitArkivProposeFact(supabase, 'user-1', 'co-1', { subject_kind: 'company', subject_id: AGR, predicate: 'shoe_size', value: 44, rationale: 'x' })).toMatchObject({ status: 400, error: expect.stringContaining('Okänt faktum') })
    expect(await commitArkivProposeFact(supabase, 'user-1', 'co-1', { subject_kind: 'company', subject_id: AGR, predicate: 'amount', value: 44, rationale: 'x' })).toMatchObject({ status: 400 })
  })

  it('refuses a subject that is not the company\'s', async () => {
    expect(await commitArkivProposeFact(supabase, 'user-1', 'co-1', { subject_kind: 'company', subject_id: AGR, predicate: 'vat_period', value: 'kvartal', rationale: 'x' })).toMatchObject({ status: 404 })
    enqueue({ data: null })
    expect(await commitArkivProposeFact(supabase, 'user-1', 'co-1', { subject_kind: 'agreement', subject_id: AGR, predicate: 'amount', value: 1, rationale: 'x' })).toMatchObject({ status: 404 })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('records the approved fact with the agent as asserter and the approver as approved_by', async () => {
    enqueue({ data: { id: AGR } })
    enqueue({ data: 'fact-9' })
    const out = await commitArkivProposeFact(supabase, 'user-1', 'co-1', { subject_kind: 'agreement', subject_id: AGR, predicate: 'notice_months', value: 6, rationale: 'Tillägget sänker uppsägningstiden.', evidence: { document_id: AGR, page: 2, quote: 'sex månader' } })
    expect(out).toEqual({ data: { fact_id: 'fact-9', subject_kind: 'agreement', subject_id: AGR, predicate: 'notice_months', value: 6 } })
    expect(rpc).toHaveBeenCalledWith('record_company_fact', expect.objectContaining({ p_predicate: 'notice_months', p_value: 6, p_source_kind: 'agent', p_asserted_by_agent_id: 'agent-mcp', p_approved_by_user_id: 'user-1', p_rationale: 'Tillägget sänker uppsägningstiden.', p_evidence: expect.objectContaining({ document_id: AGR, page: 2, quote: 'sex månader' }) }))
  })
})
