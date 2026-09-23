import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  MissingUnderlagQueryError,
  resolveMissingUnderlagEntries,
} from '@/lib/bookkeeping/missing-underlag'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

const E1 = '11111111-1111-4111-8111-111111111111'
const E2 = '22222222-2222-4222-8222-222222222222'
const E3 = '33333333-3333-4333-8333-333333333333'
const candidate = (id: string) => ({ id })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('resolveMissingUnderlagEntries: supplier-invoice reference lookup (#2395)', () => {
  it('sends the candidate chunk once per URL: two .in() lookups, never one .or() over both FKs', async () => {
    enqueue({ data: [candidate(E1), candidate(E2), candidate(E3)], error: null }) // candidates
    enqueue({ data: [], error: null }) // no direct documents
    enqueue({ data: [], error: null }) // SI by registration FK
    enqueue({ data: [], error: null }) // SI by payment FK
    enqueue({ data: [], error: null }) // no SI payment rows
    enqueue({ data: [], error: null }) // no exemptions
    enqueue({ data: [], error: null }) // no customer invoices pointing at the entries
    enqueue({ data: [], error: null }) // no invoice payment rows

    const missing = await resolveMissingUnderlagEntries(client, 'company-1', {}, { idOnly: true })

    expect(missing.map((e) => e.id)).toEqual([E1, E2, E3])
    // The doubled .or() is what pushed one lookup over an 8 KB proxy header
    // buffer (414 on self-hosted Kong) while the single-list lookups passed.
    expect(findCalls('supplier_invoices', 'or')).toHaveLength(0)
    expect(findCalls('supplier_invoices', 'in')).toEqual([
      ['registration_journal_entry_id', [E1, E2, E3]],
      ['payment_journal_entry_id', [E1, E2, E3]],
    ])
    // Both lookups stay scoped to the company and to invoices with a document.
    expect(findCalls('supplier_invoices', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['company_id', 'company-1'],
    ])
    expect(findCalls('supplier_invoices', 'not')).toEqual([
      ['document_id', 'is', null],
      ['document_id', 'is', null],
    ])
  })

  it('treats an anchored reference from either lookup as underlag, unanchored from neither', async () => {
    enqueue({ data: [candidate(E1), candidate(E2), candidate(E3)], error: null })
    enqueue({ data: [], error: null }) // no direct documents
    enqueue({
      data: [
        {
          registration_journal_entry_id: E1,
          payment_journal_entry_id: null,
          document: { journal_entry_id: E1 }, // anchored
        },
      ],
      error: null,
    })
    enqueue({
      data: [
        {
          registration_journal_entry_id: null,
          payment_journal_entry_id: E2,
          document: { journal_entry_id: E2 }, // anchored
        },
        {
          registration_journal_entry_id: null,
          payment_journal_entry_id: E3,
          document: { journal_entry_id: null }, // unanchored: deletable, not underlag
        },
      ],
      error: null,
    })
    enqueue({ data: [], error: null }) // no SI payment rows
    enqueue({ data: [], error: null }) // no exemptions
    enqueue({ data: [], error: null }) // no customer invoices pointing at the entries
    enqueue({ data: [], error: null }) // no invoice payment rows

    const missing = await resolveMissingUnderlagEntries(client, 'company-1', {}, { idOnly: true })

    expect(missing.map((e) => e.id)).toEqual([E3])
  })

  it('chunks the candidate list at 150 ids and issues both supplier-invoice lookups per chunk', async () => {
    const ids = Array.from(
      { length: 151 },
      (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
    )
    enqueue({ data: ids.map(candidate), error: null })
    for (let chunk = 0; chunk < 2; chunk++) {
      enqueue({ data: [], error: null }) // documents
      enqueue({ data: [], error: null }) // SI by registration FK
      enqueue({ data: [], error: null }) // SI by payment FK
      enqueue({ data: [], error: null }) // SI payment rows
      enqueue({ data: [], error: null }) // exemptions
      enqueue({ data: [], error: null }) // customer invoices
      enqueue({ data: [], error: null }) // invoice payment rows
    }

    const missing = await resolveMissingUnderlagEntries(client, 'company-1', {}, { idOnly: true })

    expect(missing).toHaveLength(151)
    const inCalls = findCalls('supplier_invoices', 'in')
    expect(inCalls.map(([column, list]) => [column, (list as string[]).length])).toEqual([
      ['registration_journal_entry_id', 150],
      ['payment_journal_entry_id', 150],
      ['registration_journal_entry_id', 1],
      ['payment_journal_entry_id', 1],
    ])
    expect(findCalls('supplier_invoices', 'or')).toHaveLength(0)
  })

  it('carries the driver error as cause alongside the user-facing Swedish text', async () => {
    enqueue({ data: [candidate(E1)], error: null })
    enqueue({ data: [], error: null }) // documents
    const driverError = { message: 'Request-URI Too Large', code: '414', details: null, hint: null }
    enqueue({ data: null, error: driverError }) // SI by registration FK fails

    const thrown = await resolveMissingUnderlagEntries(client, 'company-1').catch((e) => e)

    expect(thrown).toBeInstanceOf(MissingUnderlagQueryError)
    // The raw driver error survives for the server log, unmapped.
    expect(thrown.cause).toBe(driverError)
    // What the user sees went through the shared mapper, same as before.
    expect(thrown.userMessage).toBe(getErrorMessage(driverError))
    expect(thrown.message).toBe(thrown.userMessage)
  })
})
