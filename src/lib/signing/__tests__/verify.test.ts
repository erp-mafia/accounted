/**
 * The public check of a signed file: found by the signed copy's archived
 * hash or by the original's, only for a completed request, and answered
 * with what the copy's Signeringsbevis page already prints.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { COMPANY, REQ } from './fixtures'
import { isSha256Hex, verifySignedFile } from '../verify'

const HASH = 'ab'.repeat(32)
const COMPLETED_AT = '2026-10-24T12:30:00.000Z'
const REQUEST = { id: REQ, company_id: COMPANY, title: 'Hyresavtal 2026', completed_at: COMPLETED_AT }
const SIGNERS = [
  { role_label: 'VD', signed_at: '2026-10-24T12:00:00.000Z', bankid_given_name: 'Anna', bankid_surname: 'Andersson' },
  { role_label: null, signed_at: COMPLETED_AT, bankid_given_name: 'Erik', bankid_surname: 'Eriksson' },
]

let db: ReturnType<typeof createTableMockSupabase>
let signedCopies: Array<{ id: string }>
let bySignedCopy: unknown[]
let byOriginal: unknown[]

const requests: TableMockResolver = (calls) =>
  calls.some((c) => c.method === 'in') ? { data: bySignedCopy } : { data: byOriginal }

beforeEach(() => {
  vi.clearAllMocks()
  signedCopies = [{ id: 'signed-doc' }]
  bySignedCopy = [REQUEST]
  byOriginal = []
  db = createTableMockSupabase({
    document_attachments: () => ({ data: signedCopies }),
    signing_requests: requests,
    signing_request_signers: { data: SIGNERS },
    companies: { data: { name: 'Bolaget AB' } },
  })
})

describe('verifySignedFile', () => {
  it('answers null for anything that is not a SHA-256, without reading anything', async () => {
    expect(isSha256Hex(HASH)).toBe(true)
    expect(isSha256Hex('xyz')).toBe(false)
    expect(await verifySignedFile(db.supabase as never, 'not-a-hash')).toBeNull()
    expect(await verifySignedFile(db.supabase as never, HASH.slice(1))).toBeNull()
    expect(db.tables()).toEqual([])
  })

  it('finds a signed copy by its archived hash, only among the system\'s own documents and completed requests', async () => {
    const found = await verifySignedFile(db.supabase as never, ` ${HASH.toUpperCase()} `)
    expect(found).toEqual({
      match: 'signed_copy',
      title: 'Hyresavtal 2026',
      company_name: 'Bolaget AB',
      completed_at: COMPLETED_AT,
      signers: [
        { name: 'Anna Andersson', role_label: 'VD', signed_at: '2026-10-24T12:00:00.000Z' },
        { name: 'Erik Eriksson', role_label: null, signed_at: COMPLETED_AT },
      ],
    })
    expect(db.findCalls('document_attachments', 'eq')).toEqual([['sha256_hash', HASH], ['upload_source', 'system']])
    expect(db.findCalls('signing_requests', 'in')).toEqual([['signed_document_id', ['signed-doc']]])
    expect(db.findCalls('signing_requests', 'eq')).toEqual(expect.arrayContaining([['status', 'completed']]))
    expect(db.findCalls('signing_request_signers', 'eq')).toEqual(expect.arrayContaining([['signing_request_id', REQ], ['status', 'signed']]))
  })

  it('never answers a personnummer, an email or an id', async () => {
    const found = JSON.stringify(await verifySignedFile(db.supabase as never, HASH))
    expect(found).not.toContain(REQ)
    expect(found).not.toContain(COMPANY)
    expect(found).not.toMatch(/@|personnummer/)
    expect(db.findCall('signing_request_signers', 'select')).toEqual(['role_label, signed_at, bankid_given_name, bankid_surname'])
  })

  it('falls back to the original the signatures carry', async () => {
    signedCopies = []
    byOriginal = [REQUEST]
    const found = await verifySignedFile(db.supabase as never, HASH)
    expect(found).toMatchObject({ match: 'original', title: 'Hyresavtal 2026' })
    expect(db.findCalls('signing_requests', 'eq')).toEqual(expect.arrayContaining([['document_sha256', HASH], ['status', 'completed']]))
  })

  it('answers null when nothing completed matches, or the company is gone', async () => {
    signedCopies = []
    expect(await verifySignedFile(db.supabase as never, HASH)).toBeNull()
    signedCopies = [{ id: 'signed-doc' }]
    db.setTable('companies', { data: null })
    expect(await verifySignedFile(db.supabase as never, HASH)).toBeNull()
  })
})
