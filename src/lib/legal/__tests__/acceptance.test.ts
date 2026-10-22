import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { ACCEPTED_DOCUMENTS, LEGAL_DOCUMENTS } from '../documents'
import { currentAcceptanceVersions, readAcceptanceState, recordAcceptances, storeAnalyticsConsent } from '../acceptance'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()

beforeEach(() => reset())

const current = () => ACCEPTED_DOCUMENTS.map((key) => ({ document_key: key, version: LEGAL_DOCUMENTS[key].acceptanceVersion }))

describe('readAcceptanceState', () => {
  it('lists every document for a person who accepted nothing', async () => {
    enqueue({ data: [] })
    enqueue({ data: null })
    expect(await readAcceptanceState(supabase as never, 'user-1')).toEqual({ pending: ACCEPTED_DOCUMENTS, analyticsConsent: null })
  })

  it('lists nothing once every current version is accepted, and returns the analytics choice', async () => {
    enqueue({ data: current() })
    enqueue({ data: { analytics_consent: true } })
    expect(await readAcceptanceState(supabase as never, 'user-1')).toEqual({ pending: [], analyticsConsent: true })
  })

  it('asks again for a document accepted only at an older version', async () => {
    const rows = current().map((r) => (r.document_key === 'dpa' ? { ...r, version: '2020-01-01' } : r))
    enqueue({ data: rows })
    enqueue({ data: { analytics_consent: false } })
    expect(await readAcceptanceState(supabase as never, 'user-1')).toEqual({ pending: ['dpa'], analyticsConsent: false })
  })

  it('never puts the prompt up on a failed read, and leaves analytics off when that read fails', async () => {
    enqueue({ error: { message: 'down' } })
    enqueue({ error: { message: 'down' } })
    expect(await readAcceptanceState(supabase as never, 'user-1')).toEqual({ pending: [], analyticsConsent: null })
  })
})

describe('writes', () => {
  it('records each document once, idempotently', async () => {
    await recordAcceptances(supabase as never, {
      userId: 'user-1',
      companyId: null,
      method: 'accept_all',
      documents: currentAcceptanceVersions(),
    })
    const calls = findCalls('legal_acceptances', 'upsert') as Array<[Record<string, unknown>, Record<string, unknown>]>
    expect(calls.map(([row]) => row.document_key)).toEqual(ACCEPTED_DOCUMENTS)
    expect(calls[0][0]).toMatchObject({ user_id: 'user-1', company_id: null, method: 'accept_all' })
    expect(calls[0][1]).toEqual({ onConflict: 'user_id,document_key,version', ignoreDuplicates: true })
  })

  it('throws when the acceptance cannot be stored', async () => {
    enqueue({ error: { message: 'denied' } })
    await expect(
      recordAcceptances(supabase as never, { userId: 'user-1', companyId: null, method: 'accept_documents', documents: currentAcceptanceVersions() }),
    ).rejects.toThrow(/denied/)
  })

  it('stores the analytics choice with when it was made', async () => {
    enqueue({ data: null })
    await storeAnalyticsConsent(supabase as never, 'user-1', false)
    const [row] = findCall('user_preferences', 'upsert') as [Record<string, unknown>]
    expect(row).toMatchObject({ user_id: 'user-1', analytics_consent: false })
    expect(typeof row.analytics_consent_at).toBe('string')
  })
})
