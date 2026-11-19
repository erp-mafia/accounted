/**
 * Every company outside Arcim Technology AB that processes personal data for
 * the hosted service: the single list behind /subprocessors (the DPA's
 * sub-processor list) and the recipient table on /privacy.
 *
 * `scope` decides where a row shows:
 *   - 'customer': processes the customer's bookkeeping data on our behalf,
 *     i.e. a sub-processor under the DPA (art. 28.2 and 28.4).
 *   - 'own': processes data we are controller for (accounts, billing,
 *     security, product analytics), i.e. our processor under /privacy.
 *   - 'both'.
 *
 * Adding a 'customer' or 'both' row is a sub-processor change: the DPA
 * promises 30 days' notice before it takes effect, so bump
 * LEGAL_DOCUMENTS.subprocessors.updatedAt and send the notice first.
 *
 * Every claim here must be provable from code or from the vendor's own
 * published terms; tests in app/(public)/privacy/__tests__ pin the ones the
 * code decides (regions, masking, which AI provider).
 */

export type RecipientScope = 'customer' | 'own' | 'both'

export interface Recipient {
  /** Legal entity, as the vendor contracts. */
  name: string
  /** What we use them for. */
  purpose: string
  /** Which personal data reaches them. */
  data: string
  /** Where the processing happens. */
  location: string
  /** Transfer mechanism, or why there is no third-country transfer. */
  safeguard: string
  scope: RecipientScope
  /** Set when the vendor is only involved once something is switched on. */
  activation?: string
}

export const RECIPIENTS: Recipient[] = [
  {
    name: 'Supabase Inc.',
    purpose:
      'Databas, inloggning och fillagring för tjänsten och för Accounted Connect, vår egen tjänst för bank-, Skatteverket- och Peppolkopplingar.',
    data: 'All data i tjänsten: konton, bokföring, uppladdade underlag.',
    location: 'Sverige (AWS eu-north-1, Stockholm)',
    safeguard:
      'Lagring i Sverige. Supabase är ett amerikanskt bolag; för eventuell åtkomst från tredje land gäller EU-kommissionens standardavtalsklausuler (2021/914) i Supabases biträdesavtal.',
    scope: 'both',
  },
  {
    name: 'Vercel Inc.',
    purpose: 'Drift av appen och dess serverfunktioner, även för Accounted Connect.',
    data: 'All trafik till och från tjänsten, samt tekniska loggar (bland annat IP-adress).',
    location: 'Sverige (Stockholm) för serverfunktioner; statiskt innehåll via globalt CDN',
    safeguard: 'EU-U.S. Data Privacy Framework (Vercel är certifierat).',
    scope: 'both',
  },
  {
    name: 'Amazon Web Services EMEA SARL (Amazon Bedrock)',
    purpose:
      'AI-funktionerna: kategorisering av transaktioner, tolkning av kvitton och fakturor, assistenten och tolkning av kvitton i kopplade brevlådor. AI-anropen skickas till Amazon Bedrock, och modellerna som används är Anthropics Claude-modeller, körda inom Bedrock.',
    data: 'Bokföringsdata och uppladdade underlag som AI-funktionen behöver för uppgiften.',
    location:
      'EU. Anropen görs från eu-north-1 (Stockholm) och behandlas i någon av AWS EU-regioner.',
    safeguard:
      'Ingen tredjelandsöverföring. Bedrock lagrar inte prompter eller svar efter anropet, delar dem inte med modelleverantören och använder dem inte för att träna modeller.',
    scope: 'customer',
  },
  {
    name: 'Resend',
    purpose:
      'E-post: inloggningslänkar och notiser, fakturor och påminnelser som du skickar, länkar till lönebesked, samt e-post som skickas till tjänstens inkorgsadresser.',
    data: 'Mottagarens adress och e-postmeddelandets innehåll, inklusive bifogade fakturor.',
    location: 'USA',
    safeguard: 'EU-U.S. Data Privacy Framework (Resend är certifierat).',
    scope: 'both',
  },
  {
    name: 'PostHog Inc. (PostHog Cloud EU)',
    purpose:
      'Felrapportering och supportärenden som du skickar i appen, samt produktanalys och sessionsinspelning enligt integritetspolicyn.',
    data: 'Användar-ID, e-postadress, namn och företagsnamn; meddelanden i supportärenden; tekniska felrapporter. Sessionsinspelningar maskerar allt du skriver och allt innehåll.',
    location: 'EU (Frankfurt)',
    safeguard: 'Lagring inom EU. Standardavtalsklausuler vid eventuell åtkomst utanför EES.',
    scope: 'both',
  },
  {
    name: 'Upstash, Inc.',
    purpose: 'Begränsning av antalet anrop, som skydd mot överbelastning och missbruk.',
    data: 'Räknare per förkortad IP-adress (sista delen borttagen) och per användar- eller företags-ID. Räknarna raderas automatiskt inom en timme. Inget bokföringsinnehåll.',
    location: 'EU (Frankfurt)',
    safeguard: 'EU-U.S. Data Privacy Framework (Upstash är certifierat).',
    scope: 'own',
  },
  {
    name: 'Enable Banking Oy',
    purpose: 'Bankkoppling (PSD2): hämtning av saldon och transaktioner från din bank.',
    data: 'Kontouppgifter, saldon och transaktioner med motparter och meddelanden, samt din IP-adress och webbläsare under bankens inloggning.',
    location: 'Finland (EU)',
    safeguard: 'Ingen tredjelandsöverföring.',
    scope: 'customer',
    activation: 'När du kopplar en bank via Enable Banking.',
  },
  {
    name: 'Open Payments Europe AB',
    purpose:
      'Bankkoppling och betalningar (PSD2) via Accounted Connect: hämtning av transaktioner och initiering av betalningar som du godkänner med BankID.',
    data: 'Kontouppgifter, transaktioner och betalningar, samt personnummer för den som loggar in i banken.',
    location: 'Sverige',
    safeguard: 'Ingen tredjelandsöverföring.',
    scope: 'customer',
    activation: 'När du kopplar en bank via Open Payments.',
  },
  {
    name: 'Qvalia AB',
    purpose: 'Peppol: skickar och tar emot e-fakturor via Accounted Connect.',
    data: 'Fakturor med köparens och säljarens uppgifter.',
    location: 'Sverige',
    safeguard: 'Ingen tredjelandsöverföring.',
    scope: 'customer',
    activation: 'När ditt företag skickar eller tar emot e-faktura via Peppol.',
  },
  // Kivra and Billo: lib/digital-mailboxes (read the company's mailbox into
  // Inkorgen, send as the company). Gated per company by
  // DIGITAL_MAILBOX_COMPANY_IDS; opening them to customers who signed up
  // before these rows were listed needs the 30-day notice (DPA point 6).
  // Kivra's entity, location and safeguard are from its published privacy
  // notice (kivra.se, read 2026-11-02).
  {
    name: 'Kivra Sverige AB, org.nr 556917-3544',
    purpose:
      'Digital brevlåda: hämtar post från ditt företags Kivra-brevlåda till Inkorgen och skickar dokument som du väljer att skicka, till exempel fakturor och lönebesked, till mottagarens brevlåda.',
    data: 'Mottagarens namn och personnummer eller organisationsnummer, samt innehållet i dokumenten.',
    location: 'Sverige eller EU/EES; vissa av Kivras underleverantörer finns i USA',
    safeguard:
      'För Kivras underleverantörer i USA: EU-U.S. Data Privacy Framework eller standardavtalsklausuler.',
    scope: 'customer',
    activation: 'När du kopplar ditt företags Kivra-brevlåda eller skickar via Kivra.',
  },
  // Billo's org.nr is from its own payment terms and Bolagsverket's register;
  // its hosting (Binero Cloud, data managed only in Sweden) is from Binero's
  // published Billo case study (read 2026-11-03).
  {
    name: 'Billo AB, org.nr 559138-6718',
    purpose:
      'Digital brevlåda: hämtar post från ditt företags Billo-brevlåda till Inkorgen och skickar dokument som du väljer att skicka, till exempel fakturor och lönebesked, till mottagarens brevlåda.',
    data: 'Mottagarens namn och personnummer eller organisationsnummer, samt innehållet i dokumenten.',
    location: 'Sverige',
    safeguard: 'Ingen tredjelandsöverföring.',
    scope: 'customer',
    activation: 'När du kopplar ditt företags Billo-brevlåda eller skickar via Billo.',
  },
  {
    name: 'Meta Platforms Ireland Ltd (WhatsApp Business Platform)',
    purpose: 'Kvitton som du skickar till Accounteds WhatsApp-nummer, och den korta dialogen om dem.',
    data: 'Ditt telefonnummer, chattmeddelanden och kvittobilder.',
    location: 'Irland; meddelandeinnehåll lagras i vila i EU (Tyskland)',
    safeguard:
      'Standardavtalsklausuler (modul 2) i WhatsApps villkor för vidareöverföring till Meta Platforms Inc. i USA.',
    scope: 'both',
    activation: 'När du kopplar ditt telefonnummer till WhatsApp-inlämning.',
  },
  {
    name: 'The Intelligence Company AB (TIC), org.nr 559487-1682',
    purpose: 'BankID-inloggning och uppslag av företagsuppgifter och befattningar i offentliga register.',
    data: 'Personnummer och namn vid BankID-inloggning, samt organisationsnummer vid uppslag.',
    location: 'Sverige',
    safeguard: 'Ingen tredjelandsöverföring.',
    scope: 'own',
  },
  {
    name: 'Stripe Payments Europe Ltd',
    purpose: 'Betalning och fakturering av ditt abonnemang hos oss.',
    data: 'Namn, e-post, faktureringsadress, organisationsnummer och betalningsuppgifter.',
    location: 'Irland, med vidareöverföring till Stripe i USA',
    safeguard: 'EU-U.S. Data Privacy Framework (Stripe är certifierat).',
    scope: 'own',
  },
  // Cloudflare Turnstile is wired (lib/auth/turnstile.ts) but off on hosted:
  // no NEXT_PUBLIC_TURNSTILE_SITE_KEY. Setting the key adds a recipient, so
  // add its row here in the same change.
]

export function recipientsFor(view: 'dpa' | 'privacy'): Recipient[] {
  return RECIPIENTS.filter((r) =>
    view === 'dpa' ? r.scope !== 'own' : r.scope !== 'customer',
  )
}
