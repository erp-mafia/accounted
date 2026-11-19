import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { VoucherLinkSchema, getVoucherLinks, toCompactLinks } from '../voucher-links'

const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const TX1 = '11111111-1111-4111-8111-111111111111'
const TX2 = '22222222-2222-4222-8222-222222222222'
const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const INV = '33333333-3333-4333-8333-333333333333'
const IP = '44444444-4444-4444-8444-444444444444'
const SI = '55555555-5555-4555-8555-555555555555'
const SIP = '66666666-6666-4666-8666-666666666666'
const SET = '77777777-7777-4777-8777-777777777777'

describe('getVoucherLinks', () => {
  it('reads every link of the verifikat, company-scoped, with the basis each recorded', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      transactions: { data: [{ id: TX1, link_basis: 'user_created', link_evidence: null }] },
      transaction_voucher_links: { data: [{ transaction_id: TX2, link_basis: 'user_confirmed', link_evidence: null }] },
      document_attachments: { data: [{ id: DOC, link_basis: 'system_derived', link_evidence: { rule_id: 'bank_row_document_pin' } }] },
      invoice_payments: {
        data: [{ id: IP, invoice_id: INV, transaction_id: TX1, link_basis: 'rule_ocr_reference', link_evidence: { rule_id: 'auto_reference', reference: '4711', score: 0.9 } }],
      },
      supplier_invoice_payments: { data: [{ id: SIP, supplier_invoice_id: SI, transaction_id: null, link_basis: null, link_evidence: null }] },
      account_reconciliation_settlements: { data: [{ settlement_id: SET, link_basis: 'client_asserted', link_evidence: null }] },
    })

    const links = await getVoucherLinks(supabase as unknown as SupabaseClient, CO, JE)

    for (const table of [
      'transactions',
      'transaction_voucher_links',
      'document_attachments',
      'invoice_payments',
      'supplier_invoice_payments',
      'account_reconciliation_settlements',
    ]) {
      const eqs = findCalls(table, 'eq')
      expect(eqs, table).toContainEqual(['company_id', CO])
      expect(eqs, table).toContainEqual(['journal_entry_id', JE])
    }
    // An undone settlement no longer links anything.
    expect(findCalls('account_reconciliation_settlements', 'is')).toContainEqual(['undone_at', null])

    expect(links.map((l) => [l.kind, l.basis])).toEqual([
      ['bank_transaction', 'user_created'],
      ['bank_transaction', 'user_confirmed'],
      ['document', 'system_derived'],
      ['invoice_payment', 'rule_ocr_reference'],
      ['supplier_invoice_payment', null],
      ['ledger_settlement', 'client_asserted'],
    ])
    expect(links[0]).toMatchObject({ transaction_id: TX1, via: 'pointer' })
    expect(links[1]).toMatchObject({ transaction_id: TX2, via: 'voucher_link' })
    expect(links[3]).toMatchObject({ invoice_payment_id: IP, invoice_id: INV, transaction_id: TX1, evidence: { rule_id: 'auto_reference', reference: '4711', score: 0.9 } })
    expect(links[4]).toMatchObject({ supplier_invoice_payment_id: SIP, supplier_invoice_id: SI, evidence: null })
    for (const l of links) expect(VoucherLinkSchema.safeParse(l).success).toBe(true)
  })

  it('reads a basis outside the vocabulary as unknown, never passing it through', async () => {
    const { supabase } = createTableMockSupabase({
      transactions: { data: [{ id: TX1, link_basis: 'guessed', link_evidence: 'not-an-object' }] },
    })
    const [only] = await getVoucherLinks(supabase as unknown as SupabaseClient, CO, JE)
    expect(only).toMatchObject({ kind: 'bank_transaction', basis: null, evidence: null })
  })

  it('throws on a failed read, so a caller can tell unknown from none', async () => {
    const { supabase } = createTableMockSupabase({
      document_attachments: { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } },
    })
    await expect(getVoucherLinks(supabase as unknown as SupabaseClient, CO, JE)).rejects.toThrow()
  })
})

describe('toCompactLinks', () => {
  it('keeps the identifiers a link has, its basis even when null, and evidence only when recorded', () => {
    expect(
      toCompactLinks([
        {
          kind: 'invoice_payment',
          transaction_id: TX1,
          via: null,
          document_id: null,
          invoice_id: INV,
          invoice_payment_id: IP,
          supplier_invoice_id: null,
          supplier_invoice_payment_id: null,
          settlement_id: null,
          basis: null,
          evidence: null,
        },
      ]),
    ).toEqual([{ kind: 'invoice_payment', transaction_id: TX1, invoice_id: INV, invoice_payment_id: IP, basis: null }])
  })
})
