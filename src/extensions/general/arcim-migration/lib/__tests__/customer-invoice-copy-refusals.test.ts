import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FortnoxApiError } from '@/lib/providers/fortnox/client'
import {
  COPY_REFUSAL_RETRY_AFTER_MS,
  MAX_KEPT_COPY_REFUSALS,
  copyRefusalCauses,
  currentCopyRefusals,
  keepCopyRefusals,
  permanentCopyRefusal,
  readCopyRefusals,
  type CopyRefusal,
} from '../customer-invoice-copy-refusals'

const NOW = Date.parse('2026-11-13T02:00:00Z')
const fortnoxBody = (code: number, message: string) => JSON.stringify({ ErrorInformation: { error: 1, message, code } })
const refusal = (over: Partial<CopyRefusal> = {}): CopyRefusal => ({
  status: 400,
  code: '2000999',
  message: 'Kan inte skapa utskrift.',
  at: new Date(NOW - 60_000).toISOString(),
  ...over,
})

/** extension_data holding one value; records what is upserted. */
function store(initial: unknown = null, failWith?: string) {
  const state: { value: unknown; rows: Record<string, unknown>[] } = { value: initial, rows: [] }
  const supabase = {
    from: () => {
      const node = {
        select: () => node,
        eq: () => node,
        maybeSingle: () =>
          Promise.resolve(
            failWith
              ? { data: null, error: { message: failWith } }
              : { data: state.value === null ? null : { value: state.value }, error: null },
          ),
        upsert: (row: Record<string, unknown>) => {
          state.rows.push(row)
          state.value = row.value
          return Promise.resolve({ error: null })
        },
      }
      return node
    },
  } as unknown as SupabaseClient
  return { supabase, state }
}

describe('permanentCopyRefusal', () => {
  it("keeps Fortnox's status, code and sentence for a client error on the one invoice", () => {
    const error = new FortnoxApiError('Fortnox API error: 400 Bad Request', 400, fortnoxBody(2000999, 'Kan inte skapa utskrift.'))
    expect(permanentCopyRefusal(error, NOW)).toEqual({
      status: 400,
      code: '2000999',
      message: 'Kan inte skapa utskrift.',
      at: '2026-11-13T02:00:00.000Z',
    })
  })

  it('reads a body without a code or a sentence as a refusal with neither', () => {
    expect(permanentCopyRefusal(new FortnoxApiError('gone', 404), NOW)).toMatchObject({ status: 404, code: null, message: null })
  })

  it.each([401, 408, 425, 429, 500, 502, 503])('is not final for %i: a later call may be answered', (status) => {
    expect(permanentCopyRefusal(new FortnoxApiError('x', status), NOW)).toBeNull()
  })

  it('is not final for anything that is not a Fortnox answer', () => {
    expect(permanentCopyRefusal(new Error('CUSTOMER_INVOICE_PREVIEW_NOT_PDF'), NOW)).toBeNull()
    expect(permanentCopyRefusal(new DOMException('timeout', 'TimeoutError'), NOW)).toBeNull()
  })
})

describe('currentCopyRefusals', () => {
  it("answers the account's refusals that are younger than the retry window", () => {
    const stored = {
      acct: {
        '1001': refusal(),
        '1002': refusal({ at: new Date(NOW - COPY_REFUSAL_RETRY_AFTER_MS - 1).toISOString() }),
        '1003': { status: 'x' },
      },
      other: { '2001': refusal() },
    }
    expect([...currentCopyRefusals(stored, 'acct', NOW).keys()]).toEqual(['1001'])
  })

  it('answers nothing for a value it does not know', () => {
    expect(currentCopyRefusals(null, 'acct', NOW).size).toBe(0)
    expect(currentCopyRefusals('x', 'acct', NOW).size).toBe(0)
    expect(currentCopyRefusals({ acct: 'x' }, 'acct', NOW).size).toBe(0)
  })
})

describe('readCopyRefusals / keepCopyRefusals', () => {
  const scope = { companyId: 'company-1', userId: 'user-1', accountKey: 'acct' }

  it('adds to what is stored, for this account only, and drops what expired or settled', async () => {
    const { supabase, state } = store({
      acct: {
        '1001': refusal(),
        '1002': refusal({ at: new Date(NOW - COPY_REFUSAL_RETRY_AFTER_MS - 1).toISOString() }),
        '1003': refusal(),
      },
      other: { '2001': refusal() },
    })

    await keepCopyRefusals(supabase, scope, new Map([['1004', refusal({ status: 404, code: null, message: null })]]), new Set(['1003']), NOW)

    expect(state.rows[0]).toMatchObject({ company_id: 'company-1', user_id: 'user-1', extension_id: 'arcim-migration', key: 'customer_invoice_copy_refusals' })
    const value = state.value as Record<string, Record<string, CopyRefusal>>
    expect(Object.keys(value.acct).sort()).toEqual(['1001', '1004'])
    expect(value.other).toEqual({ '2001': refusal() })
    expect([...(await readCopyRefusals(supabase, 'company-1', 'acct', NOW)).keys()].sort()).toEqual(['1001', '1004'])
  })

  it('stops keeping at the cap, so the value cannot grow without bound', async () => {
    const full = Object.fromEntries(Array.from({ length: MAX_KEPT_COPY_REFUSALS }, (_, index) => [String(index + 1), refusal()]))
    const { supabase, state } = store({ acct: full })

    await keepCopyRefusals(supabase, scope, new Map([['999999', refusal()]]), new Set(), NOW)

    const kept = (state.value as Record<string, Record<string, CopyRefusal>>).acct
    expect(Object.keys(kept)).toHaveLength(MAX_KEPT_COPY_REFUSALS)
    expect(kept['999999']).toBeUndefined()
  })

  it('throws when the store cannot be read: the caller decides it is best effort', async () => {
    const { supabase } = store(null, 'timeout')
    await expect(readCopyRefusals(supabase, 'company-1', 'acct', NOW)).rejects.toThrow(/not read: timeout/)
  })
})

describe('copyRefusalCauses', () => {
  it('groups the answers, most common first, and names no invoice', () => {
    const causes = copyRefusalCauses([
      refusal(),
      refusal({ status: 404, code: null, message: null }),
      refusal(),
    ])
    expect(causes).toEqual([
      { status: 400, code: '2000999', message: 'Kan inte skapa utskrift.', count: 2 },
      { status: 404, code: null, message: null, count: 1 },
    ])
  })
})
