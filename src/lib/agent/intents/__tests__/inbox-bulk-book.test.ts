import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { inboxBulkBook } from '../inbox-bulk-book'

// The bank leg of this sheet is what an LLM agent reads before it decides how
// to book. A foreign magnitude printed with "SEK" is worse than a missing
// value: the agent proceeds confidently on a number that is off by the
// exchange rate. These tests lock the unit to the transaction's real currency.

const ITEM_ID = '11111111-1111-1111-1111-111111111111'
const TX_ID = '22222222-2222-2222-2222-222222222222'

interface TxFixture {
  amount: number
  currency: string | null
  amount_sek: number | null
  exchange_rate: number | null
}

async function renderPromptForTx(tx: TxFixture): Promise<string> {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  enqueueMany([
    {
      data: [
        {
          id: ITEM_ID,
          matched_transaction_id: TX_ID,
          created_journal_entry_id: null,
          created_supplier_invoice_id: null,
          extracted_data: {
            supplier: { name: 'Nordvind Molntjänst' },
            invoice: { invoiceDate: '2026-05-12', currency: tx.currency ?? 'SEK' },
            totals: { total: tx.amount, vatAmount: null },
          },
        },
      ],
    },
    {
      data: [
        {
          id: TX_ID,
          date: '2026-05-12',
          amount: -tx.amount,
          currency: tx.currency,
          amount_sek: tx.amount_sek == null ? null : -tx.amount_sek,
          exchange_rate: tx.exchange_rate,
          description: 'NORDVIND MOLN',
        },
      ],
    },
  ])

  const captured = await inboxBulkBook.capture(
    { item_ids: [ITEM_ID] },
    {
      supabase: supabase as unknown as SupabaseClient,
      userId: 'user-1',
      companyId: 'company-1',
    },
  )

  return inboxBulkBook.promptTemplate({ captured, profileSummary: null, activeMemory: [] })
}

describe('inbox.bulk-book bank amount rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders a 500 EUR bank row in EUR and never calls it SEK', async () => {
    // amount_sek is stored, so BOTH legs are shown: the agent can reason about
    // the foreign amount and the SEK magnitude it will actually book.
    const out = await renderPromptForTx({
      amount: 500,
      currency: 'EUR',
      amount_sek: 5750,
      exchange_rate: 11.5,
    })

    expect(out).toContain(`bank=${(500).toLocaleString('sv-SE')} EUR`)
    expect(out).toContain(`(${(5750).toLocaleString('sv-SE')} SEK)`)
    // The old rendering printed "bank=500 SEK" for exactly this row.
    expect(out).not.toContain(`bank=${(500).toLocaleString('sv-SE')} SEK`)
  })

  it('says the SEK amount is missing instead of implying SEK when no rate is stored', async () => {
    // Neither amount_sek nor exchange_rate: there is NO known SEK value. The
    // old code multiplied by an implicit rate of 1 and labelled the result SEK.
    const out = await renderPromptForTx({
      amount: 500,
      currency: 'EUR',
      amount_sek: null,
      exchange_rate: null,
    })

    expect(out).toContain(`bank=${(500).toLocaleString('sv-SE')} EUR`)
    expect(out).toContain('SEK-belopp saknas')
    expect(out).not.toContain(`bank=${(500).toLocaleString('sv-SE')} SEK`)
    // And the agent is told not to book that row on a number it cannot trust.
    expect(out).toContain('VÄXELKURS SAKNAS')
  })

  it('derives the SEK amount from exchange_rate when amount_sek is absent', async () => {
    const out = await renderPromptForTx({
      amount: 500,
      currency: 'EUR',
      amount_sek: null,
      exchange_rate: 11.5,
    })

    expect(out).toContain(`bank=${(500).toLocaleString('sv-SE')} EUR`)
    expect(out).toContain(`(${(5750).toLocaleString('sv-SE')} SEK)`)
    expect(out).not.toContain('SEK-belopp saknas')
    expect(out).not.toContain('VÄXELKURS SAKNAS')
  })

  it('renders a plain SEK bank row unchanged', async () => {
    const out = await renderPromptForTx({
      amount: 500,
      currency: 'SEK',
      amount_sek: null,
      exchange_rate: null,
    })

    expect(out).toContain(`bank=${(500).toLocaleString('sv-SE')} SEK`)
    // No parenthesised second leg and no foreign code on the bank part. (The
    // static MOMS instruction mentions "USD/EUR", so scan the item line only.)
    const itemLine = out.split('\n').find((l) => l.includes('item_id=')) ?? ''
    expect(itemLine).not.toContain('EUR')
    expect(itemLine).toContain('bank=500 SEK,')
    expect(out).not.toContain('SEK-belopp saknas')
    expect(out).not.toContain('VÄXELKURS SAKNAS')
  })

  it('carries the transaction currency through capture alongside the SEK leg', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: [
          {
            id: ITEM_ID,
            matched_transaction_id: TX_ID,
            created_journal_entry_id: null,
            created_supplier_invoice_id: null,
            extracted_data: {},
          },
        ],
      },
      {
        data: [
          {
            id: TX_ID,
            date: '2026-05-12',
            amount: -500,
            currency: 'eur',
            amount_sek: null,
            exchange_rate: null,
            description: 'NORDVIND MOLN',
          },
        ],
      },
    ])

    const captured = await inboxBulkBook.capture(
      { item_ids: [ITEM_ID] },
      {
        supabase: supabase as unknown as SupabaseClient,
        userId: 'user-1',
        companyId: 'company-1',
      },
    )

    expect(captured.items[0].tx_amount).toBe(500)
    expect(captured.items[0].tx_currency).toBe('EUR')
    expect(captured.items[0].tx_amount_sek).toBeNull()
  })
})
