/**
 * The documents_to_sign rows (../categories.ts): one per pending signer row
 * of this user in the active company, on a request that is open and not
 * past its expiry, only while signing is switched on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const switchMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/signing/switched-on', () => ({ signingSwitchedOn: () => switchMock() }))

import { countDocumentsToSign, listDocumentsToSign } from '../categories'
import { getWorklistCounts } from '../aggregate'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'u0000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-10-25T10:00:00Z')
let db: ReturnType<typeof createTableMockSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  switchMock.mockReturnValue(true)
  db = createTableMockSupabase()
})

const supabase = () => db.supabase as unknown as SupabaseClient

describe('listDocumentsToSign', () => {
  it('lists the user\'s pending rows on open requests, soonest expiry first', async () => {
    db.setTable('signing_request_signers', {
      data: [
        { id: 'signer-1', signing_request_id: 'req-1', role_label: null },
        { id: 'signer-2', signing_request_id: 'req-2', role_label: 'Styrelseledamot' },
        { id: 'signer-3', signing_request_id: 'req-closed', role_label: null },
      ],
    })
    // The request read filters open and unexpired: a closed or expired request is simply not answered.
    db.setTable('signing_requests', {
      data: [
        { id: 'req-1', title: 'Hyresavtal', expires_at: '2026-11-08T10:00:00Z' },
        { id: 'req-2', title: 'Styrelseprotokoll', expires_at: '2026-10-30T10:00:00Z' },
      ],
    })
    expect(await listDocumentsToSign(supabase(), COMPANY, USER, NOW)).toEqual([
      { signer_id: 'signer-2', signing_request_id: 'req-2', title: 'Styrelseprotokoll', role_label: 'Styrelseledamot', expires_at: '2026-10-30T10:00:00Z' },
      { signer_id: 'signer-1', signing_request_id: 'req-1', title: 'Hyresavtal', role_label: null, expires_at: '2026-11-08T10:00:00Z' },
    ])
    expect(await countDocumentsToSign(supabase(), COMPANY, USER, NOW)).toBe(2)

    // Scoped to the company and the person, pending only; the requests open and unexpired.
    expect(db.findCalls('signing_request_signers', 'eq')).toEqual(
      expect.arrayContaining([['company_id', COMPANY], ['user_id', USER], ['status', 'pending']]),
    )
    expect(db.findCalls('signing_requests', 'eq')).toEqual(expect.arrayContaining([['company_id', COMPANY], ['status', 'open']]))
    expect(db.findCall('signing_requests', 'gt')).toEqual(['expires_at', NOW.toISOString()])
    expect(db.findCall('signing_requests', 'in')).toEqual(['id', ['req-1', 'req-2', 'req-closed']])
  })

  it('reads only columns the session is granted: never the token or the BankID session', async () => {
    db.setTable('signing_request_signers', { data: [] })
    await listDocumentsToSign(supabase(), COMPANY, USER, NOW)
    const projection = db.findCall('signing_request_signers', 'select')![0] as string
    expect(projection).not.toMatch(/token_hash|bankid_session_id|poll_lease/)
    // Nothing pending: the requests are never read.
    expect(db.tables()).toEqual(['signing_request_signers'])
  })

  it('is empty while signing is switched off, without reading anything', async () => {
    switchMock.mockReturnValue(false)
    expect(await listDocumentsToSign(supabase(), COMPANY, USER, NOW)).toEqual([])
    expect(db.tables()).toEqual([])
  })

  it('soft-fails to nothing due when a read breaks', async () => {
    db.setTable('signing_request_signers', { error: { message: 'boom' } })
    expect(await listDocumentsToSign(supabase(), COMPANY, USER, NOW)).toEqual([])
    db.setTable('signing_request_signers', { data: [{ id: 'signer-1', signing_request_id: 'req-1', role_label: null }] })
    db.setTable('signing_requests', { error: { message: 'boom' } })
    expect(await countDocumentsToSign(supabase(), COMPANY, USER, NOW)).toBe(0)
  })
})

describe('getWorklistCounts', () => {
  it('counts the rows from the list the caller already fetched, and in the total', async () => {
    const due = [{ signer_id: 'signer-1', signing_request_id: 'req-1', title: 'Hyresavtal', role_label: null, expires_at: '2026-11-08T10:00:00Z' }]
    const counts = await getWorklistCounts(supabase(), COMPANY, { documentsToSign: due })
    expect(counts.counts.documents_to_sign).toBe(1)
    expect(counts.total).toBeGreaterThanOrEqual(1)
    expect(db.tables()).not.toContain('signing_request_signers')
  })

  it('reads the person\'s rows when given a user, and counts none without one', async () => {
    db.setTable('signing_request_signers', { data: [{ id: 'signer-1', signing_request_id: 'req-1', role_label: null }] })
    db.setTable('signing_requests', { data: [{ id: 'req-1', title: 'Hyresavtal', expires_at: '2099-01-01T00:00:00Z' }] })
    expect((await getWorklistCounts(supabase(), COMPANY, { userId: USER })).counts.documents_to_sign).toBe(1)

    vi.mocked(db.supabase.from).mockClear()
    expect((await getWorklistCounts(supabase(), COMPANY)).counts.documents_to_sign).toBe(0)
    expect(db.tables()).not.toContain('signing_request_signers')
  })
})
