import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { factHistory, listLiveFacts, recordFact, recordFactsForDocument, revertFact } from '../store'
import type { ExtractedField } from '@/lib/documents/extract/fields'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const rpc = mock.supabase.rpc

const field = (value: string | number, page = 1): ExtractedField => ({ value, normalized: value, page, quote: 'q', bbox: null, confidence: 1, method: 'consensus', readings: [] })

beforeEach(() => {
  reset()
  rpc.mockClear()
})

describe('recordFact', () => {
  it('calls record_company_fact with every column and returns the id', async () => {
    enqueue({ data: 'fact-1' })
    await expect(recordFact(supabase, { companyId: 'co-1', subjectKind: 'company', subjectId: 'co-1', predicate: 'vat_period', value: 'kvartal', sourceKind: 'person', approvedByUserId: 'user-1' })).resolves.toBe('fact-1')
    expect(rpc).toHaveBeenCalledWith('record_company_fact', expect.objectContaining({ p_company_id: 'co-1', p_subject_kind: 'company', p_subject_id: 'co-1', p_predicate: 'vat_period', p_value: 'kvartal', p_value_text: 'kvartal', p_single_valued: true, p_source_kind: 'person', p_approved_by_user_id: 'user-1', p_confidence: 1 }))
  })

  it('throws when the function fails', async () => {
    enqueue({ error: { message: 'exclusion' } })
    await expect(recordFact(supabase, { companyId: 'co-1', subjectKind: 'company', subjectId: 'co-1', predicate: 'x', value: 1, sourceKind: 'person' })).rejects.toThrow('fact record failed: exclusion')
  })
})

describe('recordFactsForDocument', () => {
  it('skips what is missing, held, unread or without predicates', async () => {
    enqueue({ data: null })
    expect(await recordFactsForDocument(supabase, 'doc-1')).toEqual({ status: 'skipped', reason: 'not_found' })
    enqueue({ data: { id: 'doc-1', company_id: 'co-1', admission_state: 'held' } })
    expect(await recordFactsForDocument(supabase, 'doc-1')).toEqual({ status: 'skipped', reason: 'not_admitted' })
    enqueue({ data: { id: 'doc-1', company_id: 'co-1', admission_state: 'admitted' } })
    enqueue({ data: null })
    expect(await recordFactsForDocument(supabase, 'doc-1')).toEqual({ status: 'skipped', reason: 'no_extraction' })
    enqueue({ data: { id: 'doc-1', company_id: 'co-1', admission_state: 'admitted' } })
    enqueue({ data: { id: 'ext-1', schema_type: 'generic', payload: {}, review_fields: [] } })
    expect(await recordFactsForDocument(supabase, 'doc-1')).toEqual({ status: 'skipped', reason: 'no_predicates' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('records company facts from a registreringsbevis with the document as evidence', async () => {
    enqueue({ data: { id: 'doc-1', company_id: 'co-1', admission_state: 'admitted' } })
    enqueue({ data: { id: 'ext-1', schema_type: 'registration.bolagsverket', payload: { company_name: field('Arcim Technology AB', 2), share_capital: field(25000, 2) }, review_fields: [] } })
    enqueue({ data: 'fact-1' })
    enqueue({ data: 'fact-2' })
    expect(await recordFactsForDocument(supabase, 'doc-1')).toEqual({ status: 'recorded', facts: 2, subjectKind: 'company' })
    expect(rpc).toHaveBeenNthCalledWith(1, 'record_company_fact', expect.objectContaining({ p_subject_kind: 'company', p_subject_id: 'co-1', p_predicate: 'legal_name', p_value: 'Arcim Technology AB', p_source_kind: 'extraction', p_source_document_id: 'doc-1', p_source_extraction_id: 'ext-1', p_evidence: expect.objectContaining({ document_id: 'doc-1', page: 2, quote: 'q', field: 'company_name' }) }))
  })

  it('records agreement facts on the agreement the document made, and waits when there is none yet', async () => {
    enqueue({ data: { id: 'doc-1', company_id: 'co-1', admission_state: 'admitted' } })
    enqueue({ data: { id: 'ext-1', schema_type: 'agreement.loan', payload: { principal: field(500000) }, review_fields: [] } })
    enqueue({ data: { id: 'agr-1' } })
    enqueue({ data: 'fact-1' })
    expect(await recordFactsForDocument(supabase, 'doc-1')).toEqual({ status: 'recorded', facts: 1, subjectKind: 'agreement' })
    expect(rpc).toHaveBeenCalledWith('record_company_fact', expect.objectContaining({ p_subject_kind: 'agreement', p_subject_id: 'agr-1', p_predicate: 'principal', p_value: 500000 }))

    enqueue({ data: { id: 'doc-1', company_id: 'co-1', admission_state: 'admitted' } })
    enqueue({ data: { id: 'ext-1', schema_type: 'agreement.loan', payload: { principal: field(500000) }, review_fields: [] } })
    enqueue({ data: null })
    expect(await recordFactsForDocument(supabase, 'doc-1')).toEqual({ status: 'skipped', reason: 'no_agreement' })
  })
})

describe('reads and revert', () => {
  it('lists live facts, filters validity as of a date, and reads history', async () => {
    enqueue({ data: [{ id: 'f1' }] })
    await listLiveFacts(supabase, 'co-1', { kind: 'company', id: 'co-1' }, '2026-01-01')
    const ors = findCalls('company_facts', 'or').map((a) => a[0])
    expect(ors).toEqual(['valid_from.is.null,valid_from.lte.2026-01-01', 'valid_to.is.null,valid_to.gte.2026-01-01'])
    enqueue({ data: [{ id: 'f1' }, { id: 'f0' }] })
    await expect(factHistory(supabase, 'co-1', { kind: 'agreement', id: 'agr-1' }, 'amount')).resolves.toHaveLength(2)
  })

  it('reverts through revert_company_fact', async () => {
    enqueue({ data: 'fact-0' })
    await expect(revertFact(supabase, 'fact-1', 'fel sida')).resolves.toBe('fact-0')
    expect(rpc).toHaveBeenCalledWith('revert_company_fact', { p_fact_id: 'fact-1', p_reason: 'fel sida' })
  })
})
