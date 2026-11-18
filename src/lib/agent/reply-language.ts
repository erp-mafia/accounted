import type { Locale } from '@/i18n/config'

/**
 * The language the assistant answers in: the one the user's app renders in.
 *
 * Every assistant prompt used to say "svara på svenska" on its own, so a user
 * who ran the app in English still got every answer in Swedish. The rule now
 * lives here once, and both assistant surfaces (the Ask console and the intent
 * chats) pick it from the user's locale.
 *
 * The prompts themselves stay Swedish; only the answer changes language.
 * Statutory terms keep their Swedish names, as they do in the English UI,
 * with a short English gloss
 * so the user can follow them.
 */
export function replyLanguageRule(locale: Locale = 'sv'): string {
  if (locale === 'en') {
    return 'Du svarar alltid på engelska: användaren kör appen på engelska. Det gäller även när instruktionerna, verktygssvaren, underlagen eller tidigare meddelanden i konversationen är på svenska eller ber om svenska, och mallar och exempel i instruktionerna skriver du också på engelska. Svenska facktermer som står på myndigheternas blanketter och i appens bokföringsvyer (moms, verifikation, F-skatt, momsdeklaration, BAS-kontonamn) behåller du på svenska, med en kort engelsk förklaring första gången du använder dem, t.ex. "momsdeklaration (VAT return)".'
  }
  return 'Du svarar alltid på svenska.'
}
