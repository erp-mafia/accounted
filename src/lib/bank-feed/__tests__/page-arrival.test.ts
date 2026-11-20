import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { recordBankFeedPageArrival } from '../page-arrival'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const PAGE_DOC = '33333333-3333-4333-8333-333333333333'
const PAGE_PATH = `documents/${COMPANY}/${USER}/1760000000000_psd2-response_conn-1_acc-1_p1.json`

const arrivals: TableMockResolver = (calls) => {
  const upsert = calls.find((c) => c.method === 'upsert')
  if (upsert) return { data: [{ ...(upsert.args[0] as Record<string, unknown>), created_at: '2026-10-15T08:00:00Z' }] }
  return { data: null }
}

function db(overrides: Record<string, unknown> = {}) {
  const mock = createTableMockSupabase({
    document_attachments: {
      data: {
        id: PAGE_DOC,
        storage_path: PAGE_PATH,
        sha256_hash: 'd'.repeat(64),
        mime_type: 'application/json',
        file_size_bytes: 2048,
        file_name: 'psd2-response_conn-1_acc-1_p1.json',
      },
    },
    arrivals,
    arrival_outputs: { data: null },
    ...overrides,
  } as never)
  return { ...mock, client: mock.supabase as unknown as SupabaseClient }
}

const page = {
  companyId: COMPANY,
  userId: USER,
  documentId: PAGE_DOC,
  connectionId: 'conn-1',
  accountUid: 'acc-1',
  page: 1,
  aggregator: 'enable_banking' as const,
}

beforeEach(() => vi.clearAllMocks())

describe('bank feed page arrivals', () => {
  it('records the archived page as a bank_feed arrival pointing at its own bytes, and links it', async () => {
    const { client, payloads } = db()
    await recordBankFeedPageArrival(client, page)

    const [row] = payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(row).toMatchObject({
      company_id: COMPANY,
      source: 'bank_feed',
      source_ref: PAGE_DOC,
      fetched_by: { type: 'system', user_id: USER, label: 'enable_banking' },
      original_path: PAGE_PATH,
      original_sha256: 'd'.repeat(64),
      original_mime: 'application/json',
      original_size: 2048,
    })
    expect(row!.source_meta).toMatchObject({
      aggregator: 'enable_banking',
      bank_connection_id: 'conn-1',
      account_uid: 'acc-1',
      page: 1,
      document_id: PAGE_DOC,
    })
    const outputs = payloads('arrival_outputs', 'upsert') as Array<Record<string, unknown>>
    expect(outputs.map((o) => [o.output_kind, o.output_id, o.role])).toEqual([['document', PAGE_DOC, 'attachment']])
  })

  it('never throws, whatever the database says', async () => {
    const { client } = db({ arrivals: { data: null, error: { message: 'relation "arrivals" does not exist' } } })
    await expect(recordBankFeedPageArrival(client, { ...page, aggregator: 'open_payments' })).resolves.toBeUndefined()
    const broken = { from: () => { throw new Error('no client') } } as unknown as SupabaseClient
    await expect(recordBankFeedPageArrival(broken, page)).resolves.toBeUndefined()
  })
})
