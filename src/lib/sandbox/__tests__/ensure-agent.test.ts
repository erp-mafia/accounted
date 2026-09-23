import { describe, it, expect } from 'vitest'
import { SANDBOX_AGENT_NAME, SANDBOX_PROFILE_SUMMARY } from '../ensure-agent'

/**
 * The sandbox assistant is called "Assistenten", not a first name: nobody in
 * the sandbox chose a persona, so a first name implies a relationship the
 * visitor never opted into.
 *
 * The pairing is the part worth pinning. profile_summary is the agent's own
 * self-description inside the system prompt, so if it drifts from the display
 * name the header says one thing and the assistant introduces itself as
 * another in its first sentence: a mismatch nothing else in the stack checks.
 */
describe('sandbox agent persona', () => {
  it('is named Assistenten', () => {
    expect(SANDBOX_AGENT_NAME).toBe('Assistenten')
  })

  it('introduces itself by the same name the UI shows', () => {
    expect(SANDBOX_PROFILE_SUMMARY).toContain(`Du är ${SANDBOX_AGENT_NAME}`)
  })

  it('does not still call itself Anna anywhere in the persona', () => {
    expect(SANDBOX_AGENT_NAME).not.toContain('Anna')
    expect(SANDBOX_PROFILE_SUMMARY).not.toContain('Anna')
  })

  it('keeps the demo company description the persona depends on', () => {
    // The sandbox data is a Stockholm IT consultancy on the cash method with
    // quarterly VAT. The summary is what makes the assistant's answers match
    // the seeded books, so a rename must not quietly drop it.
    expect(SANDBOX_PROFILE_SUMMARY).toContain('enskild firma')
    expect(SANDBOX_PROFILE_SUMMARY).toContain('kontantmetoden')
    expect(SANDBOX_PROFILE_SUMMARY).toContain('momsregistrerat')
  })
})
