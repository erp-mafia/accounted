import { describe, it, expect } from 'vitest'
import { botCopy } from '@/extensions/general/whatsapp-inbox/lib/messages'

/**
 * Copy contracts that a rewrite must not quietly break. These assert the
 * PROMISE the message makes to the user, not its exact wording: rephrasing
 * is fine, dropping one of the two routing options is not.
 */
describe('m3Linked, multi-company sender', () => {
  for (const locale of ['sv', 'en'] as const) {
    it(`${locale}: names BOTH ways to route receipts`, () => {
      const msg = botCopy(locale).m3Linked({ companyName: 'Arcim Technology AB', companyCount: 7 })

      // Option 1: a default company set in the panel.
      expect(msg).toMatch(locale === 'sv' ? /standardföretag/i : /default company/i)
      // Option 2: per receipt, answered right after each one. Field feedback
      // 2026-08-05: the old copy named only option 1, which read as if the
      // per-receipt path did not exist.
      expect(msg).toMatch(locale === 'sv' ? /ett kvitto i taget/i : /one receipt at a time/i)
    })

    it(`${locale}: keeps the routing guidance out of the AI-disclosure paragraph`, () => {
      // Run together they read as a single sentence, which is how a real
      // user mis-read the disclosure. Own paragraph, always.
      const msg = botCopy(locale).m3Linked({ companyName: 'Arcim Technology AB', companyCount: 7 })
      const disclosureParagraph = msg.split('\n\n').find((p) => /AI[- ]assistant|AI-assistent/i.test(p))
      expect(disclosureParagraph).toBeDefined()
      expect(disclosureParagraph).not.toMatch(/standardföretag|default company/i)
    })
  }

  it('says nothing about company routing when the sender has exactly one company', () => {
    const msg = botCopy('sv').m3Linked({ companyName: 'Arcim Technology AB', companyCount: 1 })
    expect(msg).not.toMatch(/standardföretag/i)
    expect(msg).toMatch(/AI-assistent/)
  })
})
