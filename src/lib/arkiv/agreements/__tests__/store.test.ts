import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/documents/provenance', () => ({
  softwareAgent: vi.fn(async () => 'agent-software'),
  humanAgent: vi.fn(async () => 'agent-person'),
  recordActivity: vi.fn(async () => 'activity-1'),
}))
vi.mock('../counterparty', () => ({ resolveCounterparty: vi.fn() }))
vi.mock('@/lib/arkiv/graph/snapshot', () => ({ markCompanyGraphStale: vi.fn(async () => undefined) }))

import { deriveDocument, initialDeadlineStatus, linkByPerson, needsRederivation, withdrawDerivedAgreement } from '../store'
import { markCompanyGraphStale } from '@/lib/arkiv/graph/snapshot'
import { resolveCounterparty } from '../counterparty'
import { recordActivity } from '@/lib/documents/provenance'
import type { ExtractedField, Payload } from '@/lib/documents/extract/fields'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCall, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient

const DOC = { id: 'doc-1', company_id: 'co-1', user_id: 'user-1', file_name: 'hyresavtal.pdf', admission_state: 'admitted' }
const field = (value: string | number, page = 2): ExtractedField => ({ value, normalized: value, page, quote: null, bbox: null, confidence: 1, method: 'consensus', readings: [] })
const RENTAL: Payload = {
  landlord_name: field('Fastighets AB Kvarnen', 1),
  landlord_org_number: field('5560167452', 1),
  premises_address: field('Vasagatan 12', 1),
  monthly_rent: field(12500),
  starts_on: field('2026-01-01'),
  ends_on: field('2028-12-31', 3),
  notice_months: field(9, 3),
}
const extraction = (over: Record<string, unknown> = {}) => ({ id: 'ext-1', schema_type: 'agreement.rental', payload: RENTAL, review_fields: [], ...over })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  ;(resolveCounterparty as ReturnType<typeof vi.fn>).mockResolvedValue({ partyId: 'party-1', basis: 'proven', method: 'org_number', confidence: 1, created: false })
})

describe('deriveDocument', () => {
  it('skips what is missing, held, not an agreement or not yet extracted', async () => {
    enqueue({ data: null })
    expect(await deriveDocument(supabase, 'doc-1', { today: '2026-09-15' })).toEqual({ status: 'skipped', reason: 'not_found' })
    enqueue({ data: { ...DOC, admission_state: 'held' } })
    expect(await deriveDocument(supabase, 'doc-1', { today: '2026-09-15' })).toEqual({ status: 'skipped', reason: 'not_admitted' })
    enqueue({ data: DOC })
    enqueue({ data: null })
    expect(await deriveDocument(supabase, 'doc-1', { today: '2026-09-15' })).toEqual({ status: 'skipped', reason: 'no_extraction' })
    enqueue({ data: DOC })
    enqueue({ data: extraction({ schema_type: 'registration.bolagsverket' }) })
    expect(await deriveDocument(supabase, 'doc-1', { today: '2026-09-15' })).toEqual({ status: 'skipped', reason: 'not_agreement' })
    expect(resolveCounterparty).not.toHaveBeenCalled()
  })

  it('writes the agreement, the party and agreement links, the obligations and the deadlines from a fresh record', async () => {
    enqueue({ data: DOC })
    enqueue({ data: extraction() })
    enqueue({ data: { id: 'agr-1' } }) // agreement upsert
    enqueue({}) // retire other party links
    enqueue({ data: null }) // party link exists?
    enqueue({}) // party link insert
    enqueue({ data: null }) // agreement link exists?
    enqueue({}) // agreement link insert
    enqueue({ data: [] }) // existing obligations
    enqueue({}) // obligations insert
    enqueue({ data: [] }) // existing deadlines
    enqueue({}) // notice deadline insert
    enqueue({}) // end deadline insert

    const out = await deriveDocument(supabase, 'doc-1', { today: '2026-09-15' })

    expect(out).toEqual({ status: 'derived', agreementId: 'agr-1', obligations: 14, deadlines: 2, counterparty: 'proven', waitingOn: [] })
    expect(resolveCounterparty).toHaveBeenCalledWith(supabase, expect.objectContaining({ companyId: 'co-1', userId: 'user-1', name: 'Fastighets AB Kvarnen', orgNumber: '5560167452', citation: { field: 'landlord_org_number', page: 1, quote: null } }))
    expect(recordActivity).toHaveBeenCalledWith(supabase, expect.objectContaining({ kind: 'derive', agentId: 'agent-software', outcome: 'settled', schemaType: 'agreement.rental' }))
    expect(findCall('agreements', 'upsert')).toEqual([
      expect.objectContaining({ company_id: 'co-1', kind: 'rental', title: 'Hyresavtal Vasagatan 12', counterparty_party_id: 'party-1', amount: 12500, period: 'monthly', ends_on: '2028-12-31', notice_months: 9, status: 'active', source_document_id: 'doc-1', source_extraction_id: 'ext-1' }),
      { onConflict: 'source_document_id' },
    ])
    const links = findCalls('document_links', 'insert').map((args) => args[0])
    expect(links).toEqual([
      expect.objectContaining({ target_kind: 'party', party_id: 'party-1', basis: 'proven', method: 'org_number', evidence: { field: 'landlord_org_number', page: 1, quote: null }, activity_id: 'activity-1' }),
      expect.objectContaining({ target_kind: 'agreement', agreement_id: 'agr-1', basis: 'proven', method: 'derived' }),
    ])
    const obligations = findCall('agreement_obligations', 'insert')?.[0] as Array<Record<string, unknown>>
    expect(obligations).toHaveLength(14)
    expect(obligations[0]).toEqual({ company_id: 'co-1', agreement_id: 'agr-1', kind: 'payment', due_on: '2026-08-01', amount: 12500, currency: 'SEK', amount_is_estimate: false, direction: 'out', evidence: { fields: ['monthly_rent', 'starts_on'] } })
    const deadlines = findCalls('deadlines', 'insert').map((args) => args[0] as Record<string, unknown>)
    expect(deadlines).toEqual([
      expect.objectContaining({ company_id: 'co-1', user_id: null, title: 'Sista dag att säga upp hyresavtalet Vasagatan 12', due_date: '2028-03-31', deadline_type: 'other', priority: 'important', source: 'system', is_auto_generated: true, status: 'upcoming', source_document_id: 'doc-1', source_key: 'agreement:agr-1:notice', notes: 'Enligt hyresavtal.pdf, sida 3. Datumet räknas fram från ends_on, notice_months.' }),
      expect.objectContaining({ source_key: 'agreement:agr-1:end', due_date: '2028-12-31', priority: 'normal' }),
    ])
  })

  it('labels the agreement with a disputed name but never makes a party from it', async () => {
    enqueue({ data: DOC })
    enqueue({ data: extraction({ review_fields: ['landlord_name'] }) })
    enqueue({ data: { id: 'agr-1' } }) // agreement upsert
    enqueue({}) // retire other party links
    enqueue({ data: null }) // party link exists?
    enqueue({}) // party link insert
    enqueue({ data: null }) // agreement link exists?
    enqueue({}) // agreement link insert
    enqueue({ data: [] }) // existing obligations
    enqueue({}) // obligations insert
    enqueue({ data: [] }) // existing deadlines
    enqueue({}) // notice deadline insert
    enqueue({}) // end deadline insert
    await deriveDocument(supabase, 'doc-1', { today: '2026-09-15' })
    // Identity comes from the settled organisation number only; the disputed name is display text on the agreement.
    expect(resolveCounterparty).toHaveBeenCalledWith(supabase, expect.objectContaining({ name: null, orgNumber: '5560167452' }))
    expect(findCall('agreements', 'upsert')?.[0]).toMatchObject({ counterparty_name: 'Fastighets AB Kvarnen', title: 'Hyresavtal Vasagatan 12' })
  })

  it('on a rerun updates what changed and leaves settled, dismissed and completed rows alone', async () => {
    enqueue({ data: DOC })
    enqueue({ data: extraction() })
    enqueue({ data: { id: 'agr-1' } })
    enqueue({})
    enqueue({ data: { id: 'link-party' } }) // party link exists
    enqueue({ data: { id: 'link-agreement' } }) // agreement link exists
    enqueue({
      data: [
        { id: 'o-matched', kind: 'payment', due_on: '2026-08-01', amount: 12000, amount_is_estimate: false, status: 'matched' },
        { id: 'o-old-amount', kind: 'payment', due_on: '2026-09-01', amount: 12000, amount_is_estimate: false, status: 'expected' },
        { id: 'o-stale', kind: 'payment', due_on: '2026-09-15', amount: 12000, amount_is_estimate: false, status: 'expected' },
        { id: 'o-ancient', kind: 'payment', due_on: '2025-01-01', amount: 12000, amount_is_estimate: false, status: 'expected' },
      ],
    })
    enqueue({}) // insert the 12 new dates
    enqueue({}) // update o-old-amount
    enqueue({}) // delete o-stale
    enqueue({
      data: [
        { id: 'd-notice', source_key: 'agreement:agr-1:notice', title: 'old', due_date: '2028-01-31', is_completed: false, dismissed_at: null, status: 'upcoming' },
        { id: 'd-end', source_key: 'agreement:agr-1:end', title: 'x', due_date: '2028-12-31', is_completed: false, dismissed_at: '2026-09-01T00:00:00Z', status: 'upcoming' },
        { id: 'd-gone', source_key: 'agreement:agr-1:amortisation_start', title: 'y', due_date: '2027-01-01', is_completed: false, dismissed_at: null, status: 'upcoming' },
      ],
    })
    enqueue({}) // update d-notice
    enqueue({}) // delete d-gone

    const out = await deriveDocument(supabase, 'doc-1', { today: '2026-09-15' })

    expect(out).toMatchObject({ status: 'derived', obligations: 14, deadlines: 2 })
    expect(findCalls('document_links', 'insert')).toEqual([])
    const inserted = findCall('agreement_obligations', 'insert')?.[0] as Array<{ due_on: string }>
    expect(inserted.map((o) => o.due_on)).not.toContain('2026-08-01')
    expect(inserted.map((o) => o.due_on)).not.toContain('2026-09-01')
    expect(inserted).toHaveLength(12)
    expect(findCalls('agreement_obligations', 'update')).toEqual([[{ amount: 12500, amount_is_estimate: false, evidence: { fields: ['monthly_rent', 'starts_on'] } }]])
    expect(findCalls('agreement_obligations', 'delete')).toHaveLength(1)
    expect(findCalls('deadlines', 'update')).toEqual([[expect.objectContaining({ title: 'Sista dag att säga upp hyresavtalet Vasagatan 12', due_date: '2028-03-31', status: 'upcoming', status_changed_at: expect.any(String) })]])
    expect(findCalls('deadlines', 'delete')).toHaveLength(1)
    expect(findCalls('deadlines', 'insert')).toEqual([])
  })

  it('reports a failed write as an error', async () => {
    enqueue({ data: DOC })
    enqueue({ data: extraction() })
    enqueue({ error: { message: 'no such column' } })
    expect(await deriveDocument(supabase, 'doc-1', { today: '2026-09-15' })).toEqual({ status: 'error', reason: 'agreement upsert failed: no such column' })
  })
})

describe('linkByPerson', () => {
  it('inserts a proven person link with its activity, and reports a duplicate', async () => {
    enqueue({ data: { id: 'link-1' } })
    await expect(linkByPerson(supabase, { companyId: 'co-1', documentId: 'doc-1', userId: 'user-1', targetKind: 'asset', targetId: 'asset-1' })).resolves.toEqual({ id: 'link-1' })
    expect(findCall('document_links', 'insert')?.[0]).toMatchObject({ target_kind: 'asset', asset_id: 'asset-1', basis: 'proven', method: 'person', created_by_user_id: 'user-1', activity_id: 'activity-1' })
    enqueue({ error: { code: '23505', message: 'dup' } })
    await expect(linkByPerson(supabase, { companyId: 'co-1', documentId: 'doc-1', userId: 'user-1', targetKind: 'asset', targetId: 'asset-1' })).resolves.toEqual({ conflict: true })
  })
})

describe('withdrawDerivedAgreement', () => {
  it('deprecates the facts, deletes the deadlines and the agreement, and marks the graph stale', async () => {
    enqueue({ data: { id: 'agr-1', company_id: 'co-1', kind: 'subscription' } })
    enqueue({ data: [{ id: 'fact-1' }, { id: 'fact-2' }] })
    enqueue({ data: 'fact-0' })
    enqueue({ data: null })
    enqueue({ data: [{ id: 'dl-1' }] })
    enqueue({ error: null })
    await expect(withdrawDerivedAgreement(supabase, 'doc-1', 'supplier_invoice', 'Dokumentet är supplier_invoice, inte ett avtal')).resolves.toEqual({ status: 'withdrawn', agreementId: 'agr-1', facts: 2, deadlines: 1 })
    expect(mock.supabase.rpc).toHaveBeenCalledTimes(2)
    expect(mock.supabase.rpc).toHaveBeenCalledWith('revert_company_fact', { p_fact_id: 'fact-1', p_reason: 'Dokumentet är supplier_invoice, inte ett avtal' })
    expect(findCall('deadlines', 'like')).toEqual(['source_key', 'agreement:agr-1:%'])
    expect(findCall('agreements', 'delete')).toBeDefined()
    expect(findCalls('agreements', 'eq')).toEqual([['source_document_id', 'doc-1'], ['id', 'agr-1']])
    expect(markCompanyGraphStale).toHaveBeenCalledWith(supabase, 'co-1')
  })

  it('withdraws nothing when the document made no agreement or the new type is the same kind', async () => {
    enqueue({ data: null })
    await expect(withdrawDerivedAgreement(supabase, 'doc-1', 'receipt', 'x')).resolves.toEqual({ status: 'skipped', reason: 'no_agreement' })
    enqueue({ data: { id: 'agr-1', company_id: 'co-1', kind: 'subscription' } })
    await expect(withdrawDerivedAgreement(supabase, 'doc-1', 'agreement.subscription', 'x')).resolves.toEqual({ status: 'skipped', reason: 'same_kind' })
    expect(findCall('agreements', 'delete')).toBeUndefined()
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('finishes on a retry after a failure part-way: every step is idempotent', async () => {
    // First call: facts reverted, deadlines gone, agreement delete fails.
    enqueue({ data: { id: 'agr-1', company_id: 'co-1', kind: 'loan' } })
    enqueue({ data: [{ id: 'fact-1' }] })
    enqueue({ data: null })
    enqueue({ data: [{ id: 'dl-1' }] })
    enqueue({ error: { message: 'deadlock' } })
    await expect(withdrawDerivedAgreement(supabase, 'doc-1', 'other', 'x')).resolves.toEqual({ status: 'error', reason: 'agreement delete failed: deadlock' })
    // Retry: nothing live to revert, no deadlines left, the delete goes through.
    enqueue({ data: { id: 'agr-1', company_id: 'co-1', kind: 'loan' } })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ error: null })
    await expect(withdrawDerivedAgreement(supabase, 'doc-1', 'other', 'x')).resolves.toEqual({ status: 'withdrawn', agreementId: 'agr-1', facts: 0, deadlines: 0 })
  })

  it('reports a failed write as an error', async () => {
    enqueue({ data: { id: 'agr-1', company_id: 'co-1', kind: 'loan' } })
    enqueue({ data: [] })
    enqueue({ error: { message: 'boom' } })
    await expect(withdrawDerivedAgreement(supabase, 'doc-1', 'other', 'x')).resolves.toEqual({ status: 'error', reason: 'deadlines delete failed: boom' })
  })
})

describe('helpers', () => {
  it('sets the status the engine would', () => {
    expect(initialDeadlineStatus('2026-09-14', '2026-09-15')).toBe('overdue')
    expect(initialDeadlineStatus('2026-09-29', '2026-09-15')).toBe('action_needed')
    expect(initialDeadlineStatus('2026-09-30', '2026-09-15')).toBe('upcoming')
  })

  it('re-derives after a week', () => {
    const now = new Date('2026-09-15T00:00:00Z')
    expect(needsRederivation('2026-09-09T00:00:00Z', now)).toBe(false)
    expect(needsRederivation('2026-09-07T00:00:00Z', now)).toBe(true)
  })
})
