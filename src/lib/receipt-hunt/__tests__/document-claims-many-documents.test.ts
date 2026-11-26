/**
 * loadDocumentClaims for the documents of one bulk link call.
 *
 * gnubok_link_documents_to_vouchers stages up to 300 links and asks who
 * already holds each document. The bank rows were read with one
 * `.in('document_id', ...)`, and supabase-js puts the ids in the GET query
 * string: 300 uuids are about 11.7 KB, past a self-hosted Kong's 8 KB, so the
 * read was refused and the call failed. The fake gateway
 * (tests/gateway-supabase.ts) refuses a URL past that limit.
 */
import { describe, expect, it } from 'vitest'
import { loadDocumentClaims } from '../document-claims'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1)

describe('loadDocumentClaims: the documents of a bulk link call', () => {
  it('finds the bank row of each of 250 documents, in requests the gateway takes', async () => {
    const documents = range(250).map((n) => uuid(n, 'dddddddd'))
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase({
      pending_operations: [],
      transactions: range(250).map((n) => ({ id: uuid(n, 'bbbbbbbb'), company_id: COMPANY, document_id: uuid(n, 'dddddddd') })),
    })

    const claims = await loadDocumentClaims(supabase, COMPANY, documents)

    expect(claims.size).toBe(250)
    expect(claims.get(uuid(250, 'dddddddd'))).toEqual([
      { document_id: uuid(250, 'dddddddd'), operation_id: null, transaction_id: uuid(250, 'bbbbbbbb'), journal_entry_id: null },
    ])
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(requestsTo('transactions').map((r) => inListOf(r, 'document_id').length)).toEqual([100, 100, 50])
    expect(unmodelled).toEqual([])
  })
})
