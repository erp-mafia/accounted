import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

/**
 * The books act's provider step, after a cancel at the provider's login
 * (access_denied). The callback's own sentence only said to try again, and
 * most people who cancelled at Fortnox never connected and never took the SIE
 * upload either. A cancel now reads like a closed login window: try again, or
 * upload a SIE file further down the same page.
 */

const booksSv = createTranslator({ locale: 'sv', messages: sv, namespace: 'books' })
const booksEn = createTranslator({ locale: 'en', messages: en, namespace: 'books' })
const stepSource = readFileSync(join(__dirname, '..', 'steps', 'ProviderStep.tsx'), 'utf8')

describe('provider step, a cancel at the provider', () => {
  it('offers both ways on, naming the provider, in both locales', () => {
    expect(booksSv('provider_cancelled', { provider: 'Fortnox' })).toBe(
      'Anslutningen hos Fortnox avbröts innan den blev klar. Försök igen. Gick det inte att godkänna hos Fortnox går det lika bra att ladda upp en SIE-fil, längre ner på sidan.',
    )
    expect(booksEn('provider_cancelled', { provider: 'Fortnox' })).toBe(
      'The connection at Fortnox was cancelled before it was done. Try again. If approving at Fortnox did not work, uploading a SIE file works just as well, further down the page.',
    )
  })

  it('names the SIE upload the step shows on the same screen', () => {
    // The pointer must lead somewhere: the step's own button below the error.
    expect(booksSv('provider_sie_instead')).toBe('Ladda upp SIE-fil i stället')
    expect(stepSource).toContain("t('provider_sie_instead')")
  })

  it('shows its own sentence on a cancel and the provider message on any other error', () => {
    expect(stepSource).toContain(
      "setError(cancelled ? t('provider_cancelled', { provider: provName }) : getErrorMessage(reason, { locale }))",
    )
  })
})
