import { describe, it, expect } from 'vitest'
import { transactionCategorization } from '../transaction-categorization'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The reported bug, end to end.
 *
 * A user photographs a restaurant receipt into WhatsApp. The bot asks who was
 * there and why, the user answers, and the answer is stored on the inbox item's
 * channel_context. The user then opens the app, clicks the bank transaction and
 * asks the assistant to book it, and is asked the same question again.
 *
 * Two independent causes, both covered here:
 *   1. The capture never selected channel_context, so the answers were invisible.
 *   2. The capture finds underlag only via matched_transaction_id, and WhatsApp
 *      intake never sets that column, so for a chat-captured receipt there was
 *      nothing to attach the answers to in the first place.
 */

const TX_ID = '11111111-1111-1111-1111-111111111111'
const COMPANY_ID = '22222222-2222-2222-2222-222222222222'

const TX_ROW = {
  id: TX_ID,
  date: '2026-05-12',
  description: 'ESPRESSO HOUSE 1234 STOCKHOLM',
  merchant_name: 'Espresso House',
  amount: -184,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  document_id: null,
  journal_entry_id: null,
}

const ANSWERED_REPRESENTATION = {
  channel: 'whatsapp',
  representation: {
    participants: [{ name: 'Anna Berg', company: 'Volvo' }],
    purpose: 'kundmöte om Q3-leveransen',
    event_date: null,
    raw_answer: 'jag och Anna Berg från Volvo, kundmöte',
    answered_at: '2026-05-12T13:00:00Z',
  },
}

const WHATSAPP_ITEM = {
  id: 'item-1',
  document_id: 'doc-1',
  extracted_data: {
    supplier: { name: 'Espresso House' },
    invoice: { invoiceDate: '2026-05-12', currency: 'SEK' },
    totals: { total: 184, vatAmount: 22 },
  },
  channel_context: ANSWERED_REPRESENTATION,
}

/**
 * Drive the real capture. Queue order matches the query order in capture():
 * transaction, receipts, matched inbox items, then the candidate scan (only
 * reached when nothing was linked).
 */
async function captureWith(opts: {
  matchedItems?: unknown[]
  unmatchedItems?: unknown[]
}) {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  const matched = opts.matchedItems ?? []
  enqueueMany([
    { data: TX_ROW },
    { data: [] },
    { data: matched },
    // #1425's backfill-by-document_id issues a query only when an underlag was
    // found and lacks chat_answers; the candidate scan runs only when nothing
    // was found at all, so exactly one of the two consumes this slot.
    ...(matched.length > 0 ? [{ data: [] }] : [{ data: opts.unmatchedItems ?? [] }]),
  ])
  return transactionCategorization.capture(
    { transaction_id: TX_ID },
    {
      supabase: supabase as unknown as SupabaseClient,
      userId: 'user-1',
      companyId: COMPANY_ID,
    },
  )
}

function render(captured: Awaited<ReturnType<typeof captureWith>>) {
  return transactionCategorization.promptTemplate({
    captured,
    profileSummary: null,
    activeMemory: [],
  })
}

describe('ask-once: WhatsApp answers reach the in-app assistant', () => {
  it('carries answers from a matched WhatsApp underlag into the prompt', async () => {
    const captured = await captureWith({ matchedItems: [WHATSAPP_ITEM] })
    const out = render(captured)

    expect(out).toContain('deltagare (uppgivna av användaren)')
    expect(out).toContain('Anna Berg (Volvo)')
    expect(out).toContain('kundmöte om Q3-leveransen')
    // and the instruction that makes the agent act on them
    expect(out).toContain('Fråga ALDRIG om något som redan står där')
  })

  it('finds an UNMATCHED WhatsApp receipt, which is the reported scenario', async () => {
    // matched_transaction_id is NULL on every WhatsApp item, so the matched
    // query returns nothing and the candidate scan is what saves the user.
    const captured = await captureWith({ matchedItems: [], unmatchedItems: [WHATSAPP_ITEM] })

    expect(captured.underlag).toHaveLength(1)
    expect(captured.underlag[0].match).toBe('candidate')

    const out = render(captured)
    expect(out).not.toContain('UNDERLAG: saknas')
    expect(out).toContain('TROLIGT UNDERLAG')
    expect(out).toContain('Anna Berg (Volvo)')
    // A candidate is a proposal, not a link: the agent must get it confirmed.
    expect(out).toContain('en människa måste bekräfta kopplingen')
  })

  it('does not re-ask about representation after the user answered "nej"', async () => {
    const denied = {
      ...WHATSAPP_ITEM,
      channel_context: {
        channel: 'whatsapp',
        representation: {
          participants: [],
          purpose: null,
          event_date: null,
          raw_answer: 'nej',
          answered_at: '2026-05-12T13:00:00Z',
          denied: true,
        },
      },
    }
    const captured = await captureWith({ matchedItems: [denied] })
    const out = render(captured)

    // The verifikat renderer produces nothing at all for a denial, which is
    // why the prompt is built from the structured record instead.
    expect(out).toContain('INTE representation')
  })

  it('still asks when nothing has been captured', async () => {
    const captured = await captureWith({
      matchedItems: [
        { id: 'item-2', document_id: 'doc-2', extracted_data: WHATSAPP_ITEM.extracted_data, channel_context: null },
      ],
    })
    const out = render(captured)

    // No captured answer, so no data line. ("REDAN BESVARAT" still appears in
    // the standing instruction, hence matching on the rendered marker.)
    expect(out).not.toContain('uppgivna av användaren')
    // The original instruction survives for the genuinely unanswered case.
    expect(out).toContain('Hur många var ni, och vilka?')
  })

  it('surfaces an unanswered question the chat gave up on, and only that one', async () => {
    const moved = {
      ...WHATSAPP_ITEM,
      channel_context: {
        channel: 'whatsapp',
        pending_question: {
          type: 'representation',
          asked_at: '2026-05-12T13:00:00Z',
          status: 'moved_to_app',
        },
      },
    }
    const captured = await captureWith({ matchedItems: [moved] })
    const out = render(captured)

    expect(out).toContain('OBESVARAD FRÅGA')
    expect(out).toContain('ägs nu av appen')
    expect(out).toContain('ställ exakt den frågan och ingen annan')
  })

  it('falls back to the ask-for-underlag branch when nothing matches at all', async () => {
    const captured = await captureWith({ matchedItems: [], unmatchedItems: [] })
    expect(captured.underlag).toHaveLength(0)
    expect(render(captured)).toContain('UNDERLAG: saknas')
  })
})
