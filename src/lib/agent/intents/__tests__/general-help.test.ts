import { describe, it, expect } from 'vitest'
import { generalHelp } from '../general-help'

// general.help is the read-only /chat assistant. These guards lock in:
//   1. no write tools reach this intent (structural read-only), and
//   2. the prompt refuses unactionable prose proposals + a fake "godkänner du?",
//      without naming pages or buttons of its own (the live console gets the
//      real menu from lib/agent/ask/ui-map.ts; hand-written copies here went stale).
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

describe('general.help: the /chat read-only assistant', () => {
  it('exposes no write tools (so /chat cannot stage a booking)', () => {
    for (const t of WRITE_TOOLS) {
      expect(generalHelp.tools).not.toContain(t)
    }
  })

  it('refuses to propose categorization in prose, and invents no UI to send the user to', () => {
    const out = renderPrompt()
    // It named a "Fråga …"-knapp on momsrapporten and a Dokumentinkorgen that
    // no menu shows; now it points to the page without inventing buttons.
    expect(out).not.toContain('Dokumentinkorgen')
    expect(out).not.toContain('"Fråga …"-knappen')
    expect(out).toContain('Hitta aldrig på knappar')
    // Must explicitly forbid per-transaction prose proposals + the fake "approve?" prompt.
    expect(out).toContain('INTE per-transaktions-bokföringsförslag')
    expect(out.toLowerCase()).toContain('godkänner du dessa')
  })

  it('forbids fabricating that it staged anything', () => {
    expect(renderPrompt()).toMatch(/ALDRIG fabricera/i)
  })
})
