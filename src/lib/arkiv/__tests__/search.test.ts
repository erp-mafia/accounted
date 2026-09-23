import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { likePattern, searchRecords } from '../search'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const rpc = mock.supabase.rpc
const CO = 'company-1'
const DOC = '11111111-1111-4111-8111-111111111111'
const AGR = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  reset()
  vi.clearAllMocks()
})

describe('searchRecords', () => {
  it('refuses a query shorter than two characters', async () => {
    await expect(searchRecords(supabase, CO, ' h ')).rejects.toThrow(/at least 2/)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('finds pages, agreements and facts, in that order, as record refs with the page', async () => {
    enqueue({ data: [{ document_id: DOC, page_no: 2, file_name: 'hyresavtal.pdf', headline: 'Hyran uppgår till <b>12 500</b>', rank: 1 }] })
    enqueue({ data: [{ id: AGR, title: 'Hyresavtal Vasagatan 12', counterparty_name: 'Kvarnen AB', kind: 'rental', ends_on: '2028-12-31' }] })
    enqueue({ data: [{ id: 'f1', predicate: 'vat_period', value_text: 'kvartal', subject_kind: 'company', subject_id: CO, source_document_id: DOC }] })
    const items = await searchRecords(supabase, CO, ' hyra ')
    expect(items).toEqual([
      { record_ref: `document:${DOC}`, kind: 'document', title: 'hyresavtal.pdf', snippet: 'Hyran uppgår till <b>12 500</b>', document_id: DOC, page: 2 },
      { record_ref: `agreement:${AGR}`, kind: 'agreement', title: 'Hyresavtal Vasagatan 12', snippet: 'rental · Kvarnen AB · till 2028-12-31', document_id: null, page: null },
      { record_ref: 'fact:f1', kind: 'fact', title: 'Momsperiod: kvartal', snippet: `company:${CO}`, document_id: DOC, page: null },
    ])
    expect(rpc).toHaveBeenCalledWith('search_document_pages', { p_company_id: CO, p_query: 'hyra', p_limit: 10 })
    expect(findCalls('agreements', 'eq')).toEqual([['company_id', CO]])
    expect(findCalls('company_facts', 'eq')).toEqual([['company_id', CO]])
  })

  it('searches only the kinds asked for, with the limit, and treats wildcards as plain spaces', async () => {
    enqueue({ data: [] })
    expect(await searchRecords(supabase, CO, '50%_x', { kinds: ['agreement'], limit: 3 })).toEqual([])
    expect(rpc).not.toHaveBeenCalled()
    expect(findCalls('agreements', 'or')).toEqual([['title.ilike.%50  x%,counterparty_name.ilike.%50  x%']])
    expect(findCalls('agreements', 'limit')).toEqual([[3]])
    expect(findCalls('company_facts', 'or')).toEqual([])
    expect(likePattern('a%b_c')).toBe('%a b c%')
  })

  it('finds facts by the Swedish name of the predicate', async () => {
    enqueue({ data: [] })
    await searchRecords(supabase, CO, 'Momsperiod', { kinds: ['fact'] })
    expect(findCalls('company_facts', 'or')[0]?.[0]).toBe('value_text.ilike.%Momsperiod%,predicate.ilike.%Momsperiod%,predicate.in.(vat_period)')
    expect(findCalls('company_facts', 'is')).toEqual([['sys_to', null]])
    expect(findCalls('company_facts', 'neq')).toEqual([['rank', 'deprecated']])
  })
})
