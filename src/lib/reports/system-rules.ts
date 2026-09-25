/**
 * The behandlingsregler the systemdokumentation has to spell out (BFNAR
 * 2013:2 p. 9.2-9.15): rules the software applies on its own, written once
 * here so the archive's `revision/systemdokumentation.json` and the
 * Systemdokumentation report (PDF) cannot drift apart. Change references
 * (PR and issue numbers) are deliberate: p. 9.16 dates changes to the
 * behandlingsregler, and app_releases plus behandlingshistorik carry the
 * date each build first ran, so a reader can tie a rule to a version.
 *
 * Swedish, because the document is räkenskapsinformation and is read by
 * revisorer and Skatteverket without the product running.
 */

/** SIE import: which account definitions survive and where amounts must land. */
export const SIE_IMPORT_RULES =
  'SIE-importer bevarar oanvända kontodefinitioner i klass 9. Oanvända konton under 1000 är källsystemets interna konton och tas inte med. Konton med belopp måste mappas till konton 1000-8999, eftersom klass 0 och 9 inte stöds som ekonomiska rapportkonton; för klass 9 med belopp föreslås 2999 OBS-konto. Källfil och kontomappningar bevaras i importarkivet.'

/** Öresavrundning on supplier invoices, both bokföringsmetoder. */
export const SUPPLIER_INVOICE_ROUNDING_RULES = {
  val: 'Avstängd som standard för nya leverantörsfakturor oavsett företagsinställning. Användaren väljer avrundning när den finns på leverantörens faktura. Redan inlästa avrundningsrader behålls även när valet är avstängt.',
  registrering:
    'När öresavrundning väljs i leverantörsfakturaeditorn sparas skillnaden till hel krona som en separat fakturarad på 3740 utan moms. Raden ingår i fakturabeloppet och bokförs vid registrering enligt faktureringsmetoden eller vid betalning enligt kontantmetoden.',
  moms: 'Avrundningsraden ändrar inte momsbeloppet och ingår inte i beskattningsunderlaget för omvänd skattskyldighet.',
  omfattning:
    'Undantaget från beskattningsunderlaget gäller bara fakturor i SEK och rader på 3740 med momssats 0 och absolutbelopp högst 0,50 kronor. Det avgränsar regeln till avrundning som editorn kan skapa, inte en allmän momstolerans. Större belopp, andra valutor och rader med annan momssats behåller tidigare behandling.',
  historik:
    'Regeln infördes i PR #2849. Programversion och första observerade driftsättning registreras i app_releases och visas i behandlingshistoriken. Äldre fakturor med enbart visningsavrundning ändras inte av denna regel.',
  betalning_kontantmetoden:
    'Enligt kontantmetoden bokförs leverantörsfakturan vid betalningen, och betalkontot krediteras med det belopp som faktiskt lämnade banken. När en banktransaktion i SEK matchas mot fakturan och beloppet avviker mindre än 1 krona från fakturabeloppet bokförs mellanskillnaden på 3740 utan moms och fakturan blir slutbetald. En avvikelse på 1 krona eller mer är en delbetalning och avvisas. När betalningen registreras utan banktransaktion och fakturan har enbart visningsavrundning (äldre fakturor) krediteras betalkontot med det avrundade beloppet att betala och mellanskillnaden bokförs på 3740. Kostnad och ingående moms bokförs alltid med fakturans exakta belopp. Regeln infördes med ärende #2852; programversion och driftsättning framgår av behandlingshistoriken. Redan bokförda verifikationer ändras inte.',
} as const

/**
 * How a verifikation lands in a series, in resolution order, plus the
 * exceptions. The concrete mappings live in the data tables named here.
 */
export const VOUCHER_SERIES_RULES = {
  ordning: [
    'Serie vald av användaren i bokföringsdialogen',
    'Bankkontots egen verifikationsserie (data/cash_accounts.json, fältet voucher_series), gäller verifikat som skapas från banktransaktioner',
    'Standardserie per verifikattyp (data/company_settings.json, fältet default_voucher_series_per_source_type)',
    'Serie A',
  ],
  undantag: [
    'Betalningar av kund- och leverantörsfakturor som matchas mot en banktransaktion använder fakturatypens serie, inte bankkontots',
    'Samlingsverifikat (bokföring av flera banktransaktioner i ett verifikat) använder standardserien för banktransaktioner',
  ],
} as const

/** What the supplier payment row means when a bank match settles a debt. */
export const SUPPLIER_PAYMENT_RULES = {
  bankmatchning:
    'supplier_invoice_payments.amount anger den reglerade skulden i fakturans valuta, inklusive eventuell öresavrundning på 3740. Beloppet motsvarar ökningen av supplier_invoices.paid_amount. Banktransaktionen och verifikatets betalningskonto visar det faktiskt utbetalda beloppet.',
  andring:
    'PR #2850 rättar bankmatchningens betalningsrad. Ändringen gäller nya matchningar från den programversion som innehåller rättningen. Programversionernas första registrerade drifttid finns i app_releases och rapporten Behandlingshistorik; fakturans betalningsdatum anger inte vilken programversion som skapade raden.',
  historik:
    'Äldre bankmatchningar med öresavrundning kan ha sparat utbetalt belopp i stället för reglerad skuld. Historiska reskontror och återföringar som använder dessa rader kan därför avvika med den tidigare avrundningen. Rättningen ändrar inte äldre betalningsrader eller redan avvikande fakturasaldon. Vid granskning jämförs raden med det ursprungliga betalningsverifikatet och banktransaktionen. Äldre delbetalningar utan avrundning har samma belopp enligt båda reglerna.',
} as const

/** Retention and integrity of the stored räkenskapsinformation. */
export const ARCHIVE_RULES = {
  lagringsregel: 'Till och med utgången av det sjunde kalenderåret efter det kalenderår då räkenskapsåret avslutades',
  gallring_tidigare_an: '1 januari det åttonde efterföljande kalenderåret',
  format: 'WORM (Write Once, Read Many)',
  integritetskontroll: 'SHA-256 hashning vid uppladdning, regelbunden verifiering',
  lagringsplats: 'Supabase Storage (krypterad)',
} as const

/** How a locked årsredovisning version is bound to its evidence. */
export const ANNUAL_REPORT_RULES = {
  versionering: 'Låsta versioner är oföränderliga och SHA-256-hashade',
  kontrollunderlag: 'Regelverksprofil, upplysningsbekräftelser och valideringsresultat sparas med versionen',
  underskrifter: 'Undertecknarlista, metod, datum och bevisreferens binds till exakt version',
  inlamning: 'Exakt skickad iXBRL-fil och Bolagsverkets kvittens arkiveras före och efter överföring',
} as const

/** BFNAR 2013:2 p. 9.15: where and how the behandlingshistorik is produced. */
export const BEHANDLINGSHISTORIK_RULES = {
  beskrivning:
    'Skapas automatiskt (BFL 5 kap. 11 §, BFNAR 2013:2 punkt 9.16): registreringstidpunkt och utförare för varje bokföringspost (journal_entries), förändringar via databasens oföränderliga ändringslogg audit_log (kontoplan, inställningar som styr bokföringen, räkenskapsår, API-nycklar, makuleringar, raderingar), rättelser i samma verifikat (journal_entry_rattelse_log) samt SIE-, bankfils- och migreringsloggar.',
  rapport: 'Rapporter > Export & arkiv > Behandlingshistorik: per räkenskapsår eller datumintervall, som PDF, CSV eller Excel',
  arkivfil: 'revision/behandlingshistorik.json i detta arkiv (råa loggrader)',
  tidszon: 'Europe/Stockholm i rapporten, UTC i JSON-filen',
} as const

/**
 * Rättelse (BFL 5 kap. 5 §) and period locks as the database enforces them.
 * Stated as the system behaves, not as policy: what is not checked is said.
 */
export const CORRECTION_AND_LOCK_RULES: readonly string[] = [
  'Bokförda verifikationer kan inte ändras eller raderas; databastriggrar avvisar varje sådan skrivning (varaktighet, BFNAR 2013:2 punkt 2.1).',
  'Stornobokning: en ny verifikation omför den felaktiga posten och länkas till originalet, som i sin tur visar rättelseposten. Alltid tillåten.',
  'Rättelse i samma verifikat: uppgifter eller rader stryks och ersätts inom verifikatet; ursprungsvärdet förblir läsbart och vem som rättade och när loggas oföränderligt i rättelseloggen. Tillåten bara i ett öppet, olåst räkenskapsår och för datum efter företagets låsdatum.',
  'Rättelse i samma verifikat spärras dessutom för stornoposter, rader i utländsk valuta, rader med kopplat underlag och rader som hör till en banktransaktion eller betalning; där återstår stornobokning.',
  'Systemet kontrollerar inte om en deklaration har lämnats för perioden. Låsdatumet sätts av företaget efter deklaration, så att bara stornobokning återstår.',
  'Ett stängt eller låst räkenskapsår och datum till och med låsdatumet tar inte emot nya bokföringsposter; spärren ligger i databasen, inte bara i gränssnittet.',
  'Ett utkast som inte bokförs makuleras; det raderas aldrig.',
]
