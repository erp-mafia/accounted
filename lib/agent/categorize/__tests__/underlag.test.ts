import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { gatherUnderlag } from '../underlag'

function makeSupabase(opts: {
  receipts?: unknown[]
  inbox?: unknown[]
  doc?: unknown | null
  throwOn?: string
}): SupabaseClient {
  return {
    from(table: string) {
      const rejects = opts.throwOn === table
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (rejects) throw new Error('db down')
          return { data: table === 'document_attachments' ? (opts.doc ?? null) : null }
        },
        // The awaited list query resolves with rows — or rejects async, exactly
        // how a real supabase query fails (never a synchronous throw from .from).
        then: (resolve: (v: { data: unknown[] }) => unknown, reject: (e: unknown) => unknown) => {
          if (rejects) return reject(new Error('db down'))
          return resolve({
            data:
              table === 'receipts' ? (opts.receipts ?? []) : table === 'invoice_inbox_items' ? (opts.inbox ?? []) : [],
          })
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
}

describe('gatherUnderlag', () => {
  it('renders a matched receipt with amount, VAT and flags', async () => {
    const supabase = makeSupabase({
      receipts: [
        {
          merchant_name: 'Biltema',
          receipt_date: '2026-08-12',
          total_amount: 499,
          vat_amount: 99.8,
          currency: 'SEK',
          is_restaurant: false,
          is_systembolaget: false,
        },
      ],
    })
    const out = await gatherUnderlag(supabase, 'c1', 't1')
    expect(out).toContain('Kvitto: Biltema')
    expect(out).toContain('2026-08-12')
    expect(out).toContain('totalt 499 SEK')
    expect(out).toContain('moms 99.8 SEK')
  })

  it('renders an inbox invoice with supplier + line items', async () => {
    const supabase = makeSupabase({
      inbox: [
        {
          extracted_data: {
            supplier: { name: 'Vercel Inc' },
            invoice: { invoiceDate: '2026-08-01', currency: 'USD' },
            totals: { total: 20, vatAmount: 0 },
            lineItems: [{ description: 'Pro plan' }, { description: 'Bandwidth' }],
          },
        },
      ],
    })
    const out = await gatherUnderlag(supabase, 'c1', 't1')
    expect(out).toContain('leverantör Vercel Inc')
    expect(out).toContain('totalt 20 USD')
    expect(out).toContain('Rader: "Pro plan"; "Bandwidth"')
  })

  it('renders the transaction attached document when a documentId is given', async () => {
    const supabase = makeSupabase({
      doc: { extracted_data: { supplier: { name: 'Telia' }, invoice: { currency: 'SEK' }, totals: { total: 349 } } },
    })
    const out = await gatherUnderlag(supabase, 'c1', 't1', 'doc-9')
    expect(out).toContain('Bifogat underlag: leverantör Telia')
    expect(out).toContain('totalt 349 SEK')
  })

  it('returns empty string when there is no underlag', async () => {
    const out = await gatherUnderlag(makeSupabase({}), 'c1', 't1')
    expect(out).toBe('')
  })

  it('is best-effort: a failing query yields empty string, not a throw', async () => {
    const out = await gatherUnderlag(makeSupabase({ throwOn: 'receipts' }), 'c1', 't1')
    expect(out).toBe('')
  })
})
