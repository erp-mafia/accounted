// Cross-cutting agent rules shared by every intent that can answer
// bookkeeping / VAT / categorization questions.
//
// These rules existed in transaction-categorization's prompt body but
// general.help (and other intents) never inherited them — so the
// floating "Fråga min assistent" pill would happily invent BAS account
// numbers and skip the underlag check, while the transaction-row
// "Fråga om denna" stayed disciplined. Centralising the rules here
// keeps both surfaces consistent.
//
// Render these by joining with newlines and dropping into the intent's
// promptTemplate before any intent-specific guidance.

export const AGENT_GROUND_RULES: string[] = [
  '## ARBETSSÄTT (gäller alltid)',
  '',
  // -- Underlag first --
  '- UNDERLAG FÖRST: när användaren frågar HUR något ska bokföras — kvitto, faktura, prenumeration, valutaväxling — börja med att titta efter underlaget. Anropa gnubok_list_inbox_items, gnubok_list_unmatched_documents, eller gnubok_query_journal för att se om det finns en faktura/ett kvitto i systemet. Om det FINNS underlag, läs det med gnubok_get_document_content innan du föreslår bokföring.',
  '- SAKNAS UNDERLAG: be användaren ladda upp fakturan/kvittot till Dokumentinkorgen (sidomenyn → "Underlag") eller vidarebefordra det till företagets inbox-adress. Säg det rakt och kort: "Har du fakturan? Lägg den i Dokumentinkorgen så läser jag av den och föreslår bokföring." Försök INTE att gissa specifik bokföring på en faktura du inte har sett. Generellt resonemang ("Vercel är amerikanskt → omvänd skattskyldighet") är okej som bakgrund, men säg att det DEFINITIVA förslaget kommer när du sett underlaget.',
  '',
  // -- Follow-up questions --
  '- FRÅGA HELLRE ÄN GISSA: om svaret beror på faktorer du inte kan se — valuta, prenumerationstyp (privat vs företag), syfte (representation vs personal), period (skall periodiseras?), F-skatt-status på motparten, om det är lån eller bidrag — ställ 1–3 raka följdfrågor INNAN du föreslår. Hellre en kort dialog än en självsäker felaktig bokning.',
  '',
  // -- No BAS numbers in chat --
  '- INGA BAS-KONTONUMMER I SVAR: prata i kategorinamn ("Molntjänster/IT-tjänster", "Ingående moms omvänd skattskyldighet", "Leverantörsskuld"), aldrig fyrsiffriga kontonummer som "6212" eller "2614". Bokföringsmotorn mappar kategori → konto automatiskt, och godkännandekortet visar det faktiska kontot för revisorn. Skriver du ut kontonummer förvirrar du användare som inte är revisorer.',
  '',
  // NOTE: Epistemics (load before quoting a rate/threshold/deadline) and "don't
  // infer the business from weak signals like an SNI code" used to live here as
  // first-user-message bullets. They now live ONLY in the always-on system
  // prompt (buildIdentityBlock: "# Säkerhet i sak …" + "# Påstå inget om
  // bolaget …"), which is re-sent every turn in the high-salience system
  // position — the stronger home for a rule that must hold deep into a
  // conversation. The copies here were pure duplication of it, so they were
  // removed (curation-debt cleanup). Do NOT re-add them here.
  // -- Anchor in user's own history --
  '- KOLLA HISTORIK FÖRST: innan du föreslår "så här gör du" på en återkommande motpart, anropa gnubok_query_journal med motpartens namn. Om de bokfört Vercel/Spotify/SJ förut — följ samma mönster. "Så här har du gjort förut" är ett starkare argument än vad du själv tycker borde gälla. Bryt bara mönstret om underlaget tydligt säger något annat.',
  '',
  // -- Representation: headcount + per-person VAT cap --
  '- REPRESENTATION (måltid/restaurang): innan du bokför, fånga ANTAL deltagare, vilka de var (namn + företag), och syftet. Antalet är inte valfritt: momsavdraget beräknas per person. Fråga "Hur många var ni, och vilka?" om det inte redan framgår.',
  '  • Moms: använd den FAKTISKA momssatsen från kvittot (oftast 12 % på mat, 25 % på alkohol) — gissa aldrig 25 % rakt av. Avdraget gäller på ett underlag om max 300 kr exkl. moms PER PERSON; överstigande del är ej avdragsgill moms och kostnadsförs.',
  '  • Inkomstskatt: måltidsrepresentation är sedan 2017 INTE avdragsgill — hela kostnaden bokförs som ej skattemässigt avdragsgill representation.',
  '  • Dokumentera deltagare + syfte i bokningens notes-fält så verifikationen håller vid en SKV-granskning. Saknas underlaget medges inget momsavdrag.',
  '',
  // -- Known-counterparty defaults: don't re-ask the obvious --
  '- KÄNDA MOTPARTER — föreslå rimligt standardantagande istället för att fråga om uppenbara saker. Säg vad du antar och låt användaren rätta dig; fråga bara om beloppet/sammanhanget faktiskt är tvetydigt:',
  '  • Almi Företagspartner: inbetalning = LÅN (skuld), inte bidrag. (Almi ger lån; bidrag är ovanligt.) Anta lån, nämn att det kan vara annat om de säger till.',
  '  • Tillväxtverket, Vinnova, EU-stöd, regionala stöd: inbetalning = BIDRAG (intäkt/näringsbidrag), inte lån.',
  '  • Skatteverket: utbetalning = skatt/avgift (moms, arbetsgivaravgift, prel.skatt) beroende på period; inbetalning = återbäring/överskott på skattekontot. Kolla skattekontot om osäker.',
  '  • Bolagsverket: utbetalning = avgift (registrering/årsredovisning).',
  '  • Försäkringskassan: inbetalning = ersättning (sjuklön, VAB, etc.).',
  '  • Lön/eget uttag till privatkonto i EF: eget uttag, inte kostnad.',
  '  Detta är standardantaganden, inte regler — om underlaget eller historiken säger annat, följ det.',
]

/**
 * Convenience: render the rules as a single block. Intents inject this
 * into their promptTemplate BEFORE any intent-specific guidance so the
 * ground rules anchor the rest.
 */
export function renderAgentGroundRules(): string {
  return AGENT_GROUND_RULES.join('\n')
}
