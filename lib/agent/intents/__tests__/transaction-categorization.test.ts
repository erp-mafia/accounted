import { describe, it, expect } from 'vitest'
import { transactionCategorization } from '../transaction-categorization'

// Locks in the prose-drift fix from /Users/jakobwennberg/.claude/plans/.
// The promptTemplate must instruct the agent to narrate using CATEGORY
// LABELS, never four-digit BAS account numbers. If a future edit
// reintroduces a "föreslå BAS-konto"-style instruction, this test fails.

const TX_ID = '11111111-1111-1111-1111-111111111111'

function stripUuidsAndDates(text: string): string {
  return text
    // RFC 4122 UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
    // ISO dates yyyy-MM-dd
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    // Swedish law references: "ML 2023:200", "BFNAR 2013:2", etc. The year
    // half can collide with the BAS class-2 range, so strip the whole
    // reference before scanning for stray BAS numbers.
    .replace(/\b\d{4}:\d{1,3}\b/g, '')
}

function renderPrompt(opts: {
  hasUnderlag: boolean
  profileSummary?: string | null
}) {
  const captured = {
    transaction: {
      id: TX_ID,
      date: '2026-05-12',
      description: 'Supabase Pte. Ltd.',
      amount: -810,
      currency: 'USD',
      counterparty_name: null,
    },
    underlag: opts.hasUnderlag
      ? [
          {
            kind: 'receipt' as const,
            document_id: 'doc-1',
            merchant_name: 'Supabase Pte. Ltd.',
            receipt_date: '2026-05-12',
            total_amount: 810,
            vat_amount: 0,
            currency: 'USD',
            is_restaurant: null,
            is_systembolaget: null,
            raw_extraction: null,
          },
        ]
      : [],
  }
  return transactionCategorization.promptTemplate({
    captured,
    profileSummary: opts.profileSummary ?? null,
    activeMemory: [],
  })
}

describe('transaction.categorization prompt template', () => {
  it('includes the transaction UUID', () => {
    const out = renderPrompt({ hasUnderlag: true })
    expect(out).toContain(`transaction_id: ${TX_ID}`)
  })

  it('instructs the agent to narrate with category names, not BAS numbers', () => {
    const out = renderPrompt({ hasUnderlag: true })
    expect(out).toContain('kategori-namn')
    expect(out).toContain('ALDRIG ett BAS-kontonummer')
  })

  it('does not embed a four-digit BAS account number in the prompt body', () => {
    // Bare four-digit BAS like "5420", "6540", "1930" must not appear in the
    // prompt, only category labels. Strip UUIDs and ISO dates first so
    // their digit fragments don't trigger false positives.
    const out = renderPrompt({ hasUnderlag: true })
    const stripped = stripUuidsAndDates(out)
    const bareFourDigits = stripped.match(/\b[12345678]\d{3}\b/g) ?? []
    expect(bareFourDigits).toEqual([])
  })

  it('still tells the agent to use category labels even with no underlag', () => {
    const out = renderPrompt({ hasUnderlag: false })
    const stripped = stripUuidsAndDates(out)
    const bareFourDigits = stripped.match(/\b[12345678]\d{3}\b/g) ?? []
    expect(bareFourDigits).toEqual([])
  })

  it('instructs the agent to use the enum from the tool schema', () => {
    const out = renderPrompt({ hasUnderlag: true })
    expect(out).toContain('Välj kategori från enum-listan')
  })

  it('instructs the agent to ask follow-up questions when the underlag is unclear', () => {
    const out = renderPrompt({ hasUnderlag: true })
    expect(out).toContain('FRÅGA användaren först')
    expect(out).toContain('oklart eller motsägelsefullt')
  })

  it('instructs the agent to ask about purpose for context-dependent categories', () => {
    // Even when extraction is complete, classification depends on context
    // the human knows: restaurant rep vs intern måltid, Systembolaget rep
    // vs gift, ICA office vs private, etc. The prompt must lock in a
    // mandatory follow-up question for these categories.
    const out = renderPrompt({ hasUnderlag: true })
    expect(out.toLowerCase()).toContain('systembolaget')
    expect(out.toLowerCase()).toContain('restaurang')
    expect(out).toContain('STÄLL en kort följdfråga')
    expect(out.toLowerCase()).toContain('hellre en fråga än en felaktig bokning')
  })

  it('points at the loaded atoms as primary source, without re-stating the system-prompt epistemics', () => {
    // Compliance content lives in the loaded atoms (swedish-vat,
    // swedish-accounting-compliance, ...). The intent prompt points at them as
    // the primary source to cite from…
    const out = renderPrompt({ hasUnderlag: true })
    expect(out.toLowerCase()).toContain('atomerna')
    expect(out).toMatch(/swedish-(vat|accounting-compliance|invoice-compliance)/)
    // …but it must NOT re-duplicate the load-before-answer epistemics rule. That
    // rule now lives once in the always-on system prompt (Block 2); re-adding it
    // here restores the triplication this cleanup removed.
    expect(out).not.toContain('12 %→6 %')
    expect(out.toLowerCase()).not.toContain('träningsdata')
  })

  it('instructs the agent to check counterparty history before proposing', () => {
    // Past bookings for the same counterparty are a stronger signal than
    // the LLM's guess. Lock in the tool call. We query the actual journal
    // (gnubok_query_journal) rather than the lossy categorization_templates
    // summary, so the agent sees full verifikat: accounts, VAT, line text.
    const out = renderPrompt({ hasUnderlag: true })
    expect(out).toContain('gnubok_query_journal')
    expect(out.toLowerCase()).toContain('så har du gjort förut')
  })

  it('instructs the agent to persist user answers via memory tool', () => {
    // Follow-up answers (rep vs intern, kund vs anställd) should be saved
    // so the agent doesn't re-ask next time a similar counterparty
    // appears.
    const out = renderPrompt({ hasUnderlag: true })
    expect(out).toContain('gnubok_remember_fact')
  })

  it('forbids redundant staging narration that the ApprovalCard already shows', () => {
    // The card renders directly below the agent's response with the risk,
    // category, BAS account, VAT lines, and Godkänn/Avslå buttons. Echoing
    // "stagear nu" / "stageat" / "godkänn i appen" duplicates the card and
    // leaves cramped run-on text. Lock the no-narration rule in.
    const out = renderPrompt({ hasUnderlag: true })
    // The prompt names the phrases the agent must avoid: "stagear nu",
    // "godkänna i appen". It also tells the agent to skip repeating the
    // card's contents.
    expect(out.toLowerCase()).toContain('stagear nu')
    expect(out.toLowerCase()).toContain('godkänna i appen')
    expect(out.toLowerCase()).toContain('godkännandekortet')
    expect(out).toMatch(/[Bb]erätta INTE för användaren/)
  })

  it('directs the user to Dokumentinkorgen when underlag is missing', () => {
    // The chat sheet no longer accepts file uploads. The agent must not
    // tell users to "drop the file in chat" or "click the paperclip":
    // those affordances were removed in v5. Documents go through the
    // Dokumentinkorgen workspace.
    const out = renderPrompt({ hasUnderlag: false })
    expect(out).toContain('Dokumentinkorgen')
    expect(out).toContain('Matcha mot transaktion')
    expect(out.toLowerCase()).not.toContain('gem-ikon')
    expect(out.toLowerCase()).not.toContain('släpp filen här i chattfönstret')
    expect(out.toLowerCase()).not.toContain('chattfönstret')
  })

  it('routes post-booking underlag to the verifikation, not back to Dokumentinkorgen', () => {
    // After a verifikation has been staged, the user must not be sent back
    // to Dokumentinkorgen: the doc belongs ON the verifikation (under
    // Bokföring). Inbox is for unbooked documents only.
    const noUnderlag = renderPrompt({ hasUnderlag: false })
    expect(noUnderlag).toContain('bifogas TILL VERIFIKATIONEN')
    expect(noUnderlag).toContain('öppna verifikationen i Bokföring')
    // The "Arbetssätt" rule that forbids repeating the upload reminder
    // after staging must also exist.
    const withUnderlag = renderPrompt({ hasUnderlag: true })
    expect(withUnderlag).toContain('Upprepa INTE underlag-uppmaningen efter stagning')
    expect(withUnderlag).toMatch(/bifogas till\s+VERIFIKATIONEN/)
  })
})
