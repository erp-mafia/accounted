import { describe, it, expect } from 'vitest'
import { renderAgentGroundRules, AGENT_GROUND_RULES } from '../shared-rules'

// AGENT_GROUND_RULES is rendered into the first user message of the bookkeeping
// intents that inject it (general.help, vat-review, invoice-draft,
// supplier_invoice.review, bokslut.step, verifikation.draft). It owns the
// bookkeeping-specific HEURISTICS: underlag-first, no BAS numbers in chat,
// counterparty history, representation, known-counterparty defaults.
//
// The cross-cutting EPISTEMICS rules (load before quoting a rate; don't infer
// the business from an SNI code) deliberately do NOT live here anymore. They
// live exactly once, in the always-on system prompt (buildIdentityBlock: see
// system-prompt.test.ts), which is re-sent every turn in the high-salience
// system position. This file guards both: that the heuristics stay, and that
// the epistemics are not re-duplicated back into the first user message.

const text = renderAgentGroundRules()

describe('agent ground rules: bookkeeping heuristics it owns', () => {
  it('keeps underlag-first, no-BAS-in-chat, history, representation, known counterparties', () => {
    expect(text).toContain('UNDERLAG FÖRST')
    expect(text).toContain('INGA BAS-KONTONUMMER')
    expect(text).toContain('KOLLA HISTORIK FÖRST')
    expect(text).toContain('REPRESENTATION')
    expect(text).toContain('KÄNDA MOTPARTER')
  })

  it('still renders as a non-trivial joined block', () => {
    expect(AGENT_GROUND_RULES.length).toBeGreaterThan(10)
    expect(text.split('\n').length).toBeGreaterThan(10)
  })
})

describe('agent ground rules: epistemics live in the system prompt, not here', () => {
  it('does not re-duplicate the always-on epistemics / anti-speculation rules', () => {
    // These moved to buildIdentityBlock (always-on Block 2). Re-adding them here
    // restores the triplication this cleanup removed.
    expect(text).not.toContain('12 %→6 %')
    expect(text).not.toContain('GISSA INTE BOLAGETS VERKSAMHET')
    expect(text).not.toContain('är du säker?')
  })
})
