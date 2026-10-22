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
  'SIE-importer bevarar oanvända kontodefinitioner i klass 9. Oanvända konton under 1000 är källsystemets interna konton och tas inte med. Konton med belopp måste mappas till konton 1000-8999, eftersom klass 0 och 9 inte stöds som ekonomiska rapportkonton; för klass 9 med belopp föreslås 2999 OBS-konto. Samma mappningsregel gäller i alla importvägar (SIE-fil, flytt från tidigare system, API och MCP) och går före en mappning till klass 9 som en tidigare import sparat; importvägar utan mappningssteg tillämpar förslaget direkt (ärende #3312). Källfil och kontomappningar bevaras i importarkivet.'

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
 * Kontantmetoden: a part payment of a customer invoice that never reached the
 * ledger as a fordran (lib/bookkeeping/invoice-lines.ts
 * buildInvoiceCashPartialLines, checked against the earlier installments by
 * checkPriorCashRecognition). Listed for a cash-method company while
 * CASH_PARTIAL_PAYMENTS_ENABLED is set, and for any company whose books hold
 * a part payment the rule booked.
 */
export const CASH_PARTIAL_PAYMENT_RULE =
  'En delbetalning av en kundfaktura som inte bokförts som fordran bokförs vid betalningen med intäkt och utgående moms per momssats i proportion till det inbetalda beloppet. Andelarna räknas på det sammanlagt inbetalda beloppet, så att delbetalningarna tillsammans ger exakt fakturans belopp per konto och varje delbetalnings moms per momssats avviker högst 1 öre från den exakta andelen. Regeln gäller inte fakturor i utländsk valuta, fakturor med ROT/RUT-avdrag eller skattereduktion för grön teknik, betalningar med egna konteringsrader, betalningar som registreras genom bankmatchning eller med API-nyckel, eller fakturor vars tidigare delbetalningar är bokförda på annat sätt. Då avvisas den automatiska bokföringen och betalningen bokförs manuellt. Programversion och driftsättning framgår av behandlingshistoriken.'

/**
 * Kvittning (lib/invoices/counterparty-setoff): a customer invoice and a
 * supplier invoice of the same counterparty settled against each other.
 * Listed while COUNTERPARTY_SETOFF_ENABLED is set, and for any company whose
 * books hold a set-off voucher.
 */
export const COUNTERPARTY_SETOFF_RULE =
  'En kundfaktura och en leverantörsfaktura till samma motpart (samma organisationsnummer) kan kvittas mot varandra med ett eget verifikat: debet leverantörsskulder och kredit kundfordringar på de konton fakturornas egna verifikat bokförde, med högst det lägsta av de två återstående beloppen. Momsen påverkas inte, eftersom den bokfördes när fakturorna registrerades. Båda fakturorna får en betalningsrad daterad kvittningsdagen och nettot matchas mot bankraden som en vanlig delbetalning. En kvittningsavräkning arkiveras som underlag på verifikatet. Kvittning görs bara i svenska kronor, för fakturor som bokförts som fordran respektive skuld (inte kontantmetoden), utan ROT/RUT-avdrag, utan pågående inkassoärende och utan pågående betalning av leverantörsfakturan. En felaktig kvittning rättas genom att verifikatet återförs (storno), vilket återställer båda fakturorna; verifikatet ändras aldrig i efterhand.'

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

/**
 * How a sales invoice gets its löpnummer (ML 17 kap 24 § p. 2): the series, the
 * next number, and when a number is refused.
 */
export const INVOICE_NUMBER_RULES = {
  serie:
    'Kundfakturor och kreditfakturor numreras i företagets egen serie: fakturaprefixet följt av ett löpnummer med minst tre siffror. Proformafakturor har en egen serie (PF-) och tar inga nummer från fakturaserien. Offerter (OF-) och följesedlar (FS-) har egna serier.',
  nasta_nummer:
    'Nästa fakturanummer är det första lediga numret från den inställda startpunkten (Inställningar > Fakturor, Nästa fakturanummer). Nummer som redan finns, till exempel importerade från ett tidigare system, hoppas över; ett överhoppat nummer finns redan och är ingen lucka.',
  unikt:
    'Ett fakturanummer är ett värde: 1 och 001 är samma löpnummer. Databasen avvisar en faktura vars nummer redan finns skrivet på ett annat sätt, oavsett om fakturan skapas, importeras eller registreras via API.',
  ordning:
    'Ett nummer delas aldrig ut under ett högre nummer som redan finns i serien, eftersom det skulle fylla en lucka i serien eller starta om den. Då stoppas utfärdandet utan att något nummer förbrukas, och företaget anger var serien fortsätter: nästa nummer efter det högsta, eller ett nytt prefix för en ny serie. Inställningen avvisar ett nummer som redan finns eller ligger under det högsta. Varje ändring av nästa fakturanummer sparas i ändringsloggen (audit_log, i arkivet revision/behandlingshistorik.json) med tidpunkt och användare. Accounteds egna nummer i det äldre formatet med årtal före löpnumret (till exempel 2026383), utfärdade före den 11 maj 2026, räknas som en avslutad serie.',
  andring:
    'Regeln infördes med migration 20261012161600; programversion och första driftsättning framgår av behandlingshistoriken. Redan utfärdade fakturor och deras nummer ändras inte.',
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

/**
 * The kontantmetoden year-end cut-off (#3440): årsomföring per invoice, no
 * vändning. Shown in the systemdokumentation as a behandlingsregel.
 */
export const KONTANTMETOD_CUTOFF_RULES =
  'Enligt kontantmetoden bokförs kund- och leverantörsfakturor som är obetalda vid räkenskapsårets utgång (BFL 5 kap 2 §) genom årsomföring: en verifikation per faktura, daterad räkenskapsårets sista dag och bokförd som fakturans registrering enligt faktureringsmetoden (intäkt eller kostnad, moms på de ordinarie momskontona, kundfordran på 1510 eller leverantörsskuld på 2440 och för ROT/RUT Skatteverkets del på 1513). Verifikationen kopplas till fakturan, så betalningen nästa år bokförs mot 1510 eller 2440 utan intäkt, kostnad eller moms, och momsen redovisas en gång, i den momsperiod som innehåller räkenskapsårets sista dag. Ingen vändning bokförs. En faktura som betalades efter årsskiftet men innan årsomföringen bokfördes rättas genom storno och rättelse av betalningsverifikationen på dess eget datum. En årsomföring kan bara ångras genom storno daterad samma dag, och bara så länge fakturan saknar betalningar och krediteringar. Äldre bokslutsavgränsningar med vändning ändras inte. Regeln infördes med ärende #3440; programversion och driftsättning framgår av behandlingshistoriken.'

/**
 * Kontantmetoden and an EU goods acquisition (#73): booked at registration,
 * because ML 2023:200 7 kap. 26 and 40 §§ fix the moms period whatever the
 * method. Shown in the systemdokumentation of a cash-method company.
 */
export const KONTANTMETOD_EU_GOODS_RULE =
  'Enligt kontantmetoden bokförs leverantörsfakturor när de betalas. En faktura för varor från ett annat EU-land (unionsinternt förvärv, omvänd skattskyldighet) bokförs ändå när den registreras, daterad fakturadatum och som en registrering enligt faktureringsmetoden (kostnad, beskattningsunderlag på 4515, 4516 eller 4517 mot 4598, beräknad moms på 2614, 2624 eller 2634 och 2645, leverantörsskuld på 2440), eftersom momsen ska redovisas för den period då fakturan utfärdats (ML 7 kap. 26 och 40 §§). Betalningen bokförs sedan mot 2440 utan kostnad eller moms. Köp av tjänster från utlandet bokförs som tidigare vid betalning (ML 7 kap. 16 och 34 §§). Regeln infördes med ärende #73; programversion och driftsättning framgår av behandlingshistoriken.'

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
  'Bokförda verifikationer kan inte ändras eller raderas utanför de två loggade rättelsevägarna nedan; databastriggrar avvisar varje annan skrivning (varaktighet, BFNAR 2013:2 punkt 2.1).',
  'Stornobokning: en ny verifikation omför den felaktiga posten och länkas till originalet, som i sin tur visar rättelseposten. Alltid tillåten.',
  'Rättelse i samma verifikat: uppgifter eller rader stryks och ersätts inom verifikatet; ursprungsvärdet förblir läsbart och vem som rättade och när loggas oföränderligt i rättelseloggen. Tillåten bara i ett öppet, olåst räkenskapsår och för datum efter företagets låsdatum.',
  'Rättelse i samma verifikat spärras dessutom för stornoposter, rader i utländsk valuta, rader med kopplat underlag och rader som hör till en banktransaktion eller betalning; där återstår stornobokning.',
  'Systemet kontrollerar inte om en deklaration har lämnats för perioden. Låsdatumet sätts av företaget efter deklaration, så att bara stornobokning återstår.',
  'Ett stängt eller låst räkenskapsår och datum till och med låsdatumet tar inte emot nya bokföringsposter; spärren ligger i databasen, inte bara i gränssnittet.',
  'Ett utkast som inte bokförs makuleras; det raderas aldrig.',
]
