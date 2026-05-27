import { describe, it, expect } from 'vitest'
import { generalHelp } from '../general-help'

// general.help is the read-only /chat assistant. These guards lock in:
//   1. no write tools reach this intent (structural read-only), and
//   2. the prompt redirects categorization/bokföring to the per-transaction
//      flow instead of giving unactionable prose proposals + a fake "godkänner du?".
// If a future edit reintroduces a write tool or softens the redirect, this fails.

const WRITE_TOOLS = [
  'gnubok_categorize_transaction',
  'gnubok_create_invoice',
  'gnubok_create_voucher',
  'gnubok_correct_entry',
  'gnubok_reverse_journal_entry',
  'gnubok_approve_supplier_invoice',
  'gnubok_mark_invoice_as_paid',
  'gnubok_run_year_end',
  'gnubok_match_transaction_to_invoice',
]

function renderPrompt() {
  return generalHelp.promptTemplate({
    captured: { route: '/transactions' },
    profileSummary: null,
    activeMemory: [],
  })
}

describe('general.help — the /chat read-only assistant', () => {
  it('exposes no write tools (so /chat cannot stage a booking)', () => {
    for (const t of WRITE_TOOLS) {
      expect(generalHelp.tools).not.toContain(t)
    }
  })

  it('redirects categorization to the Dokumentinkorgen flow instead of proposing in prose', () => {
    const out = renderPrompt()
    // Per-transaction agent help now lives in Dokumentinkorgen (match the
    // underlag to the transaction, then ask there) — not a transactions-page row
    // button, which was removed.
    expect(out).toContain('Dokumentinkorgen')
    expect(out).toContain('matcha det mot transaktionen')
    // Must explicitly forbid per-transaction prose proposals + the fake "approve?" prompt.
    expect(out).toContain('INTE per-transaktions-bokföringsförslag')
    expect(out.toLowerCase()).toContain('godkänner du dessa')
  })

  it('forbids fabricating that it staged anything', () => {
    expect(renderPrompt()).toMatch(/ALDRIG fabricera/i)
  })
})
