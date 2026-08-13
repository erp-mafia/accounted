/**
 * Outbound bot copy for the WhatsApp channel (approved conversation spec
 * M1-M18; M5-M10 are the PR4 conversation layer).
 *
 * Server-side constants, NOT messages/*.json: these strings are sent from
 * webhook/worker contexts where no next-intl session exists (same pattern as
 * lib/email/reminder-templates.ts). Domain terms (Underlag, verifikation) stay
 * Swedish in both locales per the i18n rules. WhatsApp formatting subset only
 * (*bold*, _italic_); never em/en dashes, per repo hard rule.
 *
 * Locale: the chat has no session, and no per-user locale is stored server-side
 * today, so dispatch always sends 'sv'. The 'en' variants exist so the wiring
 * is a one-line change once a stored locale exists.
 */

export type BotLocale = 'sv' | 'en'

export interface LinkedTemplateArgs {
  companyName?: string | null
  companyCount?: number
  merchant?: string | null
  amount?: string | null
  date?: string | null
  minutes?: number
}

/** Stable ids stamped into whatsapp_messages.raw_payload.template on every send
 *  (throttle checks and tests key on these, never on the copy). */
export const TEMPLATE = {
  m1Unlinked: 'm1_unlinked',
  m2BadCode: 'm2_bad_code',
  m3Linked: 'm3_linked',
  m4Ack: 'm4_ack',
  m4AckEmpty: 'm4_ack_empty',
  m4Duplicate: 'm4_duplicate',
  m5BurstAck: 'm5_burst_ack',
  m6CompanyQuestion: 'm6_company_question',
  m6CompanyConfirm: 'm6_company_confirm',
  m6CompanyRetry: 'm6_company_retry',
  m6BytPin: 'm6_byt_pin',
  m7Representation: 'm7_representation',
  m8RepConfirmed: 'm8_rep_confirmed',
  m8RepNeedPurpose: 'm8_rep_need_purpose',
  m8RepPartial: 'm8_rep_partial',
  m8RepDenied: 'm8_rep_denied',
  m9Resend: 'm9_resend',
  m9NoteSaved: 'm9_note_saved',
  m10Context: 'm10_context',
  m10ContextConfirm: 'm10_context_confirm',
  m11Stop: 'm11_stop',
  m12Start: 'm12_start',
  m13Help: 'm13_help',
  m14Voice: 'm14_voice',
  m15Unsupported: 'm15_unsupported',
  m16Fallback: 'm16_fallback',
  m17RateLimited: 'm17_rate_limited',
  m17RateLimitedDay: 'm17_rate_limited_day',
  m18Error: 'm18_error',
  m19NoCompany: 'm19_no_company',
} as const

export type TemplateId = (typeof TEMPLATE)[keyof typeof TEMPLATE]

const SV = {
  m1Unlinked: () =>
    'Hej! Det här är *Accounteds kvittomottagning*, en automatisk AI-tjänst.\n\n' +
    'För att koppla ditt nummer: öppna Accounted, gå till *Inställningar -> WhatsApp* och skicka den 6-siffriga koden här.\n\n' +
    'Skriv *hjälp* för att nå en människa.',

  m2BadCode: () =>
    'Koden stämmer inte eller har gått ut. Hämta en ny under *Inställningar -> WhatsApp* i Accounted och skicka den här inom 10 minuter.',

  m3Linked: ({ companyName, companyCount = 1 }: LinkedTemplateArgs) => {
    const intro = companyName
      ? `Klart! Ditt nummer är kopplat till *${companyName}*.`
      : 'Klart! Ditt nummer är kopplat till *Accounted*.'
    const tips =
      'Skicka kvitton hit som foto eller PDF så lägger jag dem i *Underlag* i Accounted. ' +
      'Två tips: skicka som _dokument_ (gem-ikonen) för bästa skärpa, och en fil per kvitto. Flersidiga kvitton skickas som PDF.'
    const outro =
      'Jag är en AI-assistent. Skriv *hjälp* för mänsklig support, *stopp* för att koppla från.'
    // Two real ways to route a receipt, and the old copy named only one,
    // which read as if the per-receipt path did not exist. Own paragraph:
    // run together with the outro it read as a single sentence.
    const multi =
      companyCount > 1
        ? `Du är med i ${companyCount} företag i Accounted. Välj antingen ett standardföretag i panelen, ` +
          'eller skicka ett kvitto i taget så frågar jag vilket företag det gäller direkt efter varje kvitto.\n\n'
        : ''
    return `${intro}\n\n${tips}\n\n${multi}${outro}`
  },

  m4Ack: ({ merchant, amount, date }: LinkedTemplateArgs) => {
    const who = merchant ? `${merchant}, ` : ''
    const when = date ? ` (${date})` : ''
    return `*Kvitto mottaget:* ${who}${amount}${when}. Ligger i Underlag, granska och bokför i appen.`
  },

  m4AckEmpty: () =>
    '*Kvitto mottaget.* Jag kunde inte läsa av beloppet, komplettera i appen under Underlag.',

  m4Duplicate: () => 'Det kvittot finns redan i Underlag.',

  m5BurstAck: ({ lines }: { lines: string[] }) =>
    `Fick *${lines.length}* kvitton:\n` +
    lines.map((line, i) => `${i + 1}. ${line}`).join('\n') +
    '\nAlla ligger i Underlag i Accounted.',

  // The receipt is not ingested yet when this is asked (the item is created
  // only after the company answer), so merchant/amount are unknown here.
  m6CompanyQuestion: ({ count = 1 }: { count?: number }): string =>
    count > 1 ? 'Vilket företag gäller kvittona?' : 'Vilket företag gäller kvittot?',

  m6CompanyQuestionNumbered: ({ count = 1, options }: { count?: number; options: string[] }) =>
    (count > 1 ? 'Vilket företag gäller kvittona?' : 'Vilket företag gäller kvittot?') +
    '\n\n' +
    options.map((name, i) => `${i + 1}. ${name}`).join('\n') +
    '\n\nSvara med en siffra.',

  m6CompanyConfirm: ({ companyName }: { companyName: string }) =>
    `*${companyName}*, noterat. Jag minns valet i 8 timmar (skriv *byt* för att ändra).`,

  // Typo or a typed company name while the question is open: repeat the list
  // instead of the M16 lecture or silence.
  m6CompanyRetry: ({ options }: { options: string[] }) =>
    `Jag känner inte igen svaret. Svara med en siffra 1-${options.length}:\n\n` +
    options.map((name, i) => `${i + 1}. ${name}`).join('\n'),

  m6BytPin: () => 'Okej, jag frågar vilket företag nästa gång du skickar ett kvitto.',

  m7Representation: ({ ref }: { ref?: string | null } = {}) =>
    `${ref ?? 'Det ser ut som representation.'} För att avdraget ska hålla behöver verifikationen *vilka som deltog* (namn + företag) och *syftet*.\n\n` +
    'Svara i ett meddelande, t.ex: _Lunch med Anna Berg (Volvo) och mig, uppföljning av avtal_. Svara *nej* om det inte är representation.',

  m8RepConfirmed: ({ participants, purpose }: { participants: string; purpose?: string | null }) =>
    `Tack! Noterat: ${participants}${purpose ? ` · Syfte: ${purpose}` : ''}. Följer med när kvittot bokförs.`,

  // Participants captured, purpose missing. Skatteverket wants both, so ask
  // once for the missing half only, never for the names again.
  m8RepNeedPurpose: ({ participants }: { participants: string }) =>
    `Tack! Noterat: ${participants}. En sak till: vad var syftet med mötet? Skriv en kort rad, t.ex. _uppföljning av avtal_.`,

  m8RepPartial: () =>
    'Tack! Jag har sparat ditt svar som anteckning på kvittot. Kolla att deltagare och syfte kom med när du bokför i appen.',

  m8RepDenied: () => 'Okej, ingen representation. Kvittot ligger i Underlag som vanligt.',

  m9Resend: ({ ordinal }: { ordinal?: number | null } = {}) =>
    ordinal != null
      ? `Kvitto ${ordinal} blev för lågupplöst för att läsas av, WhatsApp komprimerar foton hårt. Skicka gärna det igen som *dokument* (gem-ikonen -> _Dokument_) så behålls full skärpa.`
      : 'Bilden blev för lågupplöst för att läsas av, WhatsApp komprimerar foton hårt.\n\n' +
        'Skicka gärna samma kvitto igen som *dokument*: gem-ikonen -> _Dokument_ -> välj bilden. Då behålls full skärpa. Kvittot ligger kvar i Underlag så länge.',

  // Text arrived while a re-send question is open: the words cannot replace
  // the file, so they are kept as a note and the question stays open.
  m9NoteSaved: () =>
    'Tack! Sparat som anteckning på kvittot. Skicka gärna samma kvitto igen som *dokument* (gem-ikonen -> _Dokument_) så kan jag läsa av beloppen.',

  m10Context: ({ ordinal }: { ordinal?: number | null } = {}) =>
    ordinal != null
      ? `Kvitto ${ordinal}: jag kunde inte läsa av allt. Vad gäller köpet? Skriv en kort rad (t.ex. _taxi till kundmöte, 240 kr_) så sparar jag det på kvittot.`
      : '*Fil mottagen*, men jag kunde inte läsa av allt. Vad gäller köpet? Skriv en kort rad (t.ex. _taxi till kundmöte, 240 kr_) så sparar jag det på kvittot.',

  m10ContextConfirm: () => 'Tack! Sparat som anteckning på kvittot.',

  // Honest wording: `stopp` PAUSES the channel (muted_at), it does not revoke
  // the binding. Actually disconnecting is the settings panel's "Koppla från",
  // and the panel shows the paused state as "Pausad": the copy must match.
  m11Stop: () =>
    'Okej, jag pausar och slutar svara här. Numret är kvar kopplat men jag tar inte emot något mer. Dina underlag i Accounted påverkas inte.\n\n' +
    'Skicka *start* när du vill aktivera igen, eller koppla från numret helt under *Inställningar -> WhatsApp* i Accounted.',

  m12Start: () => 'Välkommen tillbaka! Ditt nummer är aktivt igen, skicka kvitton när du vill.',

  m13Help: () =>
    'Du når en människa på *support@accounted.se*, vi svarar vardagar, oftast samma dag. Skriv gärna vilket företag det gäller.\n\n' +
    'Här i chatten tar jag annars emot kvitton och underlag (foto eller PDF).',

  m14Voice: () =>
    'Jag kan inte lyssna på röstmeddelanden ännu. Skicka kvittot som foto eller PDF, eller skriv en kort rad text.',

  m15Unsupported: () =>
    'Jag kan bara ta emot bilder och PDF-dokument (bild max 5 MB). Skicka kvittot som foto eller PDF.',

  m16Fallback: () =>
    'Jag är en automatisk kvittomottagning och kan inte svara på frågor här i chatten. Skicka ett kvitto (foto/PDF) så tar jag hand om det, eller skriv *hjälp* för mänsklig support.',

  m17RateLimited: ({ minutes = 10 }: LinkedTemplateArgs) =>
    `Det blev många filer på kort tid, jag pausar mottagningen en stund. Försök igen om cirka ${minutes} minuter.`,

  // The 500/day company quota resets at midnight, so "cirka 10 minuter" is
  // simply wrong there: never promise a minute count we cannot keep.
  m17RateLimitedDay: () =>
    'Dagens gräns för mottagna filer är nådd för det här företaget. Jag tar emot fler i morgon, eller ladda upp direkt i appen under *Underlag* så kommer de in nu.',

  m18Error: () =>
    'Något gick fel när jag tog emot filen. Försök igen om en stund, eller ladda upp kvittot direkt i appen under *Underlag*. Skriv *hjälp* om det fortsätter.',

  // The company question could not even be asked: the linked user has fewer
  // than 2 companies to choose between, so the receipt cannot be filed and
  // nothing changes until they act in the app. Honest and actionable beats
  // the old silent parking.
  m19NoCompany: () =>
    'Jag kunde inte koppla kvittot till något företag. Öppna Accounted och kontrollera WhatsApp-kopplingen under *Inställningar -> WhatsApp*, och skicka sedan kvittot igen.',
}

const EN: typeof SV = {
  m1Unlinked: () =>
    'Hi! This is *Accounted receipt intake*, an automated AI service.\n\n' +
    'To link your number: open Accounted, go to *Settings -> WhatsApp* and send the 6-character code here.\n\n' +
    'Type *hjälp* to reach a human.',

  m2BadCode: () =>
    'That code is wrong or has expired. Get a new one under *Settings -> WhatsApp* in Accounted and send it here within 10 minutes.',

  m3Linked: ({ companyName, companyCount = 1 }: LinkedTemplateArgs) => {
    const intro = companyName
      ? `Done! Your number is linked to *${companyName}*.`
      : 'Done! Your number is linked to *Accounted*.'
    const tips =
      'Send receipts here as a photo or PDF and I will file them under *Underlag* in Accounted. ' +
      'Two tips: send as a _document_ (the paperclip icon) for full sharpness, and one file per receipt. Multi-page receipts go as PDF.'
    const outro =
      'I am an AI assistant. Type *hjälp* for human support, *stopp* to disconnect.'
    const multi =
      companyCount > 1
        ? `You belong to ${companyCount} companies in Accounted. Either pick a default company in the panel, ` +
          'or send one receipt at a time and I will ask which company it belongs to right after each one.\n\n'
        : ''
    return `${intro}\n\n${tips}\n\n${multi}${outro}`
  },

  m4Ack: ({ merchant, amount, date }: LinkedTemplateArgs) => {
    const who = merchant ? `${merchant}, ` : ''
    const when = date ? ` (${date})` : ''
    return `*Receipt received:* ${who}${amount}${when}. It is in Underlag, review and book it in the app.`
  },

  m4AckEmpty: () =>
    '*Receipt received.* I could not read the amount, complete it in the app under Underlag.',

  m4Duplicate: () => 'That receipt is already in Underlag.',

  m5BurstAck: ({ lines }: { lines: string[] }) =>
    `Got *${lines.length}* receipts:\n` +
    lines.map((line, i) => `${i + 1}. ${line}`).join('\n') +
    '\nAll of them are in Underlag in Accounted.',

  m6CompanyQuestion: ({ count = 1 }: { count?: number }) =>
    count > 1
      ? 'Which company do the receipts belong to?'
      : 'Which company does the receipt belong to?',

  m6CompanyQuestionNumbered: ({ count = 1, options }: { count?: number; options: string[] }) =>
    (count > 1
      ? 'Which company do the receipts belong to?'
      : 'Which company does the receipt belong to?') +
    '\n\n' +
    options.map((name, i) => `${i + 1}. ${name}`).join('\n') +
    '\n\nReply with a number.',

  m6CompanyConfirm: ({ companyName }: { companyName: string }) =>
    `*${companyName}*, noted. I will remember the choice for 8 hours (type *byt* to change).`,

  m6CompanyRetry: ({ options }: { options: string[] }) =>
    `I did not recognise that answer. Reply with a number 1-${options.length}:\n\n` +
    options.map((name, i) => `${i + 1}. ${name}`).join('\n'),

  m6BytPin: () => 'Okay, I will ask which company the next time you send a receipt.',

  m7Representation: ({ ref }: { ref?: string | null } = {}) =>
    `${ref ?? 'This looks like representation.'} For the deduction to hold, the verifikation needs *who attended* (name + company) and *the purpose*.\n\n` +
    'Reply in one message, e.g: _Lunch with Anna Berg (Volvo) and me, contract follow-up_. Reply *nej* if it is not representation.',

  m8RepConfirmed: ({ participants, purpose }: { participants: string; purpose?: string | null }) =>
    `Thanks! Noted: ${participants}${purpose ? ` · Purpose: ${purpose}` : ''}. It follows the receipt when it is booked.`,

  m8RepNeedPurpose: ({ participants }: { participants: string }) =>
    `Thanks! Noted: ${participants}. One more thing: what was the purpose of the meeting? A short line is enough, e.g. _contract follow-up_.`,

  m8RepPartial: () =>
    'Thanks! I saved your reply as a note on the receipt. Check that attendees and purpose came through when you book it in the app.',

  m8RepDenied: () => 'Okay, no representation. The receipt is in Underlag as usual.',

  m9Resend: ({ ordinal }: { ordinal?: number | null } = {}) =>
    ordinal != null
      ? `Receipt ${ordinal} came through at too low a resolution to read, WhatsApp compresses photos hard. Please send it again as a *document* (paperclip icon -> _Document_) to keep full sharpness.`
      : 'The image came through at too low a resolution to read, WhatsApp compresses photos hard.\n\n' +
        'Please send the same receipt again as a *document*: paperclip icon -> _Document_ -> pick the image. That keeps full sharpness. The receipt stays in Underlag meanwhile.',

  m9NoteSaved: () =>
    'Thanks! Saved as a note on the receipt. Please send the same receipt again as a *document* (paperclip icon -> _Document_) so I can read the amounts.',

  m10Context: ({ ordinal }: { ordinal?: number | null } = {}) =>
    ordinal != null
      ? `Receipt ${ordinal}: I could not read everything. What was the purchase? Write a short line (e.g. _taxi to client meeting, 240 kr_) and I will save it on the receipt.`
      : '*File received*, but I could not read everything. What was the purchase? Write a short line (e.g. _taxi to client meeting, 240 kr_) and I will save it on the receipt.',

  m10ContextConfirm: () => 'Thanks! Saved as a note on the receipt.',

  m11Stop: () =>
    'Okay, I am pausing and will stop replying here. Your number stays linked but I will not receive anything more. Your documents in Accounted are not affected.\n\n' +
    'Send *start* whenever you want to activate again, or disconnect the number entirely under *Settings -> WhatsApp* in Accounted.',

  m12Start: () => 'Welcome back! Your number is active again, send receipts whenever you like.',

  m13Help: () =>
    'You reach a human at *support@accounted.se*, we reply on weekdays, usually the same day. Please mention which company it concerns.\n\n' +
    'Here in the chat I otherwise receive receipts and documents (photo or PDF).',

  m14Voice: () =>
    'I cannot listen to voice messages yet. Send the receipt as a photo or PDF, or write a short line of text.',

  m15Unsupported: () =>
    'I can only receive images and PDF documents (image max 5 MB). Send the receipt as a photo or PDF.',

  m16Fallback: () =>
    'I am an automated receipt intake and cannot answer questions here in the chat. Send a receipt (photo/PDF) and I will handle it, or type *hjälp* for human support.',

  m17RateLimited: ({ minutes = 10 }: LinkedTemplateArgs) =>
    `That was a lot of files in a short time, I am pausing intake for a bit. Try again in about ${minutes} minutes.`,

  m17RateLimitedDay: () =>
    'This company has reached its daily limit for received files. I will accept more tomorrow, or upload directly in the app under *Underlag* to get them in now.',

  m18Error: () =>
    'Something went wrong receiving the file. Try again in a moment, or upload the receipt directly in the app under *Underlag*. Type *hjälp* if it keeps happening.',

  m19NoCompany: () =>
    'I could not assign the receipt to any company. Open Accounted and check the WhatsApp linking under *Settings -> WhatsApp*, then send the receipt again.',
}

const COPY: Record<BotLocale, typeof SV> = { sv: SV, en: EN }

export function botCopy(locale: BotLocale = 'sv'): typeof SV {
  return COPY[locale] ?? SV
}
