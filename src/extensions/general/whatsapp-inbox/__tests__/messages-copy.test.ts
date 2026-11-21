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

describe('m22LookupRetry, link lookup unavailable (#2365)', () => {
  for (const locale of ['sv', 'en'] as const) {
    it(`${locale}: asks for a resend without mentioning a code or linking`, () => {
      const msg = botCopy(locale).m22LookupRetry()

      // Most senders on this path are already linked and just sent a receipt:
      // M21 wording ("could not check the code") would be nonsense to them,
      // and anything about linking invites a second link flow.
      expect(msg).not.toMatch(locale === 'sv' ? /kod/i : /code/i)
      expect(msg).not.toMatch(locale === 'sv' ? /koppla|Inställningar/i : /link|Settings/i)
      // The promise the message makes: send the same thing again shortly.
      expect(msg).toMatch(locale === 'sv' ? /igen/i : /again/i)
    })
  }
})

describe('m4AckUnread, a file nothing read (crm#1779)', () => {
  for (const locale of ['sv', 'en'] as const) {
    it(`${locale}: says it was not read and leaves the fields to the person, without asking for it again`, () => {
      const msg = botCopy(locale).m4AckUnread()
      expect(msg).toMatch(locale === 'sv' ? /lästes inte av/i : /not read/i)
      expect(msg).toMatch(locale === 'sv' ? /fyll i/i : /fill in/i)
      expect(msg).not.toMatch(locale === 'sv' ? /skicka/i : /send/i)
      expect(msg).not.toMatch(/[–—]/)
    })
  }
})

describe('list question wording', () => {
  for (const locale of ['sv', 'en'] as const) {
    const copy = botCopy(locale)

    it(`${locale}: sends the question as filed, then the why on a line of its own`, () => {
      expect(copy.m23ListQuestion({ question: 'Gäller hyran kontoret?', why: 'Det avgör kontot.' })).toBe('Gäller hyran kontoret?\nDet avgör kontot.')
      expect(copy.m23ListQuestion({ question: 'Gäller hyran kontoret?', why: null })).toBe('Gäller hyran kontoret?')
      expect(copy.m23ListQuestion({ question: 'Gäller hyran kontoret?' })).toBe('Gäller hyran kontoret?')
    })

    it(`${locale}: fits the "Vet inte" button in a reply button title`, () => {
      expect(copy.m23ListDontKnow().length).toBeLessThanOrEqual(20)
    })

    it(`${locale}: answers in one short line without a dash`, () => {
      const lines = [copy.m24ListAnswered(), copy.m24ListClosed(), copy.m25ListEnded(), copy.m26ListAnswerTooLong({ max: 1000 })]
      for (const line of lines) {
        expect(line).not.toMatch(/\n/)
        expect(line).not.toMatch(/[–—]/)
        expect(line.length).toBeLessThanOrEqual(120)
      }
    })

    it(`${locale}: names the limit when an answer is too long`, () => {
      expect(copy.m26ListAnswerTooLong({ max: 1000 })).toContain('1000')
    })
  }

  it('sv: says "Vet inte" on the button, and that nothing new is saved for an ended question', () => {
    expect(botCopy('sv').m23ListDontKnow()).toBe('Vet inte')
    expect(botCopy('sv').m25ListEnded()).toMatch(/redan/)
    expect(botCopy('sv').m25ListEnded()).toMatch(/inget nytt svar/)
  })
})
