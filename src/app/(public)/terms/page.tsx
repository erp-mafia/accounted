import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalSection, LegalShell } from '@/components/legal/LegalShell'
import { LEGAL_DOCUMENTS } from '@/lib/legal/documents'

export function generateMetadata(): Metadata {
  return { title: 'Användarvillkor - Accounted' }
}

const link = 'text-primary underline underline-offset-4'

/**
 * The terms as published on accounted.se/terms on 2026-03-05, moved here so
 * the app is the one place the legal documents live. The wording is
 * unchanged: a change customers must agree to needs 30 days' notice
 * (point 14.1) and a new LEGAL_DOCUMENTS.terms.acceptanceVersion.
 */
export default function TermsPage() {
  return (
    <LegalShell title="Användarvillkor" updatedAt={LEGAL_DOCUMENTS.terms.updatedAt}>
      <LegalSection title="1. Parter och definitioner">
        <p>
          Dessa användarvillkor (&quot;Villkoren&quot;) gäller mellan Arcim Technology AB,
          org.nr 559538-6219, (&quot;Leverantören&quot;) och den fysiska eller juridiska
          person som registrerar ett konto i Tjänsten (&quot;Kunden&quot;).
        </p>
        <p>
          &quot;Tjänsten&quot; avser den molnbaserade bokföringstjänsten accounted, tillgänglig
          via accounted.se, inklusive samtliga funktioner, API:er, integrationer och tillägg.
        </p>
        <p>
          &quot;Användare&quot; avser varje fysisk person som använder Tjänsten under Kundens konto.
        </p>
        <p>
          &quot;Räkenskapsinformation&quot; avser all data som utgör räkenskapsinformation
          enligt 1 kap. 2 § bokföringslagen (1999:1078), inklusive verifikationer,
          grundbokföring, huvudbokföring och årsbokslut.
        </p>
      </LegalSection>

      <LegalSection title="2. Tjänstens omfattning">
        <p>
          2.1. Tjänsten tillhandahåller verktyg för löpande bokföring, fakturering,
          leverantörsreskontra, momsdeklaration, bankkoppling och rapportgenerering i
          enlighet med BAS-kontoplanen och svensk redovisningspraxis.
        </p>
        <p>2.2. Tjänsten stödjer följande företagsformer:</p>
        <ul>
          <li>Enskild firma (enskild näringsidkare)</li>
          <li>Aktiebolag</li>
        </ul>
        <p>
          2.3. Tjänsten utgör ett tekniskt hjälpmedel. Leverantören tillhandahåller inte
          redovisningstjänster, skatterådgivning eller revisionstjänster. Kunden bär det
          fulla ansvaret för att bokföringen är korrekt och uppfyller gällande lagstiftning
          i enlighet med bokföringslagen och Bokföringsnämndens allmänna råd.
        </p>
        <p>
          2.4. Leverantören garanterar inte att Tjänsten uppfyller samtliga krav i tillämplig
          lagstiftning för Kundens specifika verksamhet. Kunden ansvarar för att bedöma
          Tjänstens lämplighet.
        </p>
      </LegalSection>

      <LegalSection title="3. Registrering och konto">
        <p>
          3.1. Kunden ansvarar för att uppgifter som lämnas vid registrering är korrekta och aktuella.
        </p>
        <p>
          3.2. Kunden ansvarar för att skydda sina inloggningsuppgifter och för all aktivitet
          som sker under Kundens konto.
        </p>
        <p>
          3.3. Ett konto får inte delas mellan flera juridiska personer. Varje
          bokföringsskyldig enhet ska ha ett separat konto.
        </p>
      </LegalSection>

      <LegalSection title="4. Kundens ansvar">
        <p>4.1. Kunden ansvarar för att:</p>
        <ul>
          <li>uppfylla bokföringsskyldigheten enligt bokföringslagen (1999:1078),</li>
          <li>tillämpa god redovisningssed i enlighet med Bokföringsnämndens allmänna råd,</li>
          <li>bokföra affärshändelser löpande inom de tidsfrister som anges i BFNAR 2013:2,</li>
          <li>
            upprätta och underhålla systemdokumentation och behandlingshistorik enligt 5 kap.
            11 § BFL och BFNAR 2013:2 kapitel 9,
          </li>
          <li>upprätta en arkivplan enligt BFNAR 2013:2 punkt 8.3,</li>
          <li>upprätta årsbokslut eller årsredovisning inom lagstadgad tid.</li>
        </ul>
        <p>
          4.2. Kunden ansvarar för att verifiera att automatiskt genererade bokföringsposter,
          konteringsförslag och momsberäkningar är korrekta innan de bekräftas.
        </p>
        <p>
          4.3. Kunden ansvarar för att inte lagra personuppgifter i Tjänsten utöver vad som
          krävs för att uppfylla bokföringsskyldigheten eller annan rättslig förpliktelse.
        </p>
      </LegalSection>

      <LegalSection title="5. Leverantörens ansvar">
        <p>5.1. Leverantören ska:</p>
        <ul>
          <li>
            tillhandahålla Tjänsten med rimlig tillgänglighet (mål: 99,5 % per kalendermånad,
            exklusive planerat underhåll),
          </li>
          <li>säkerställa att data lagras inom EU/EES,</li>
          <li>
            vidta tekniska och organisatoriska åtgärder för att skydda Kundens data i
            enlighet med GDPR,
          </li>
          <li>
            möjliggöra export av Räkenskapsinformation i maskinläsbart format (SIE4) under
            hela avtalsperioden och under en skälig övergångsperiod efter avtalets upphörande.
          </li>
        </ul>
        <p>5.2. Leverantören ansvarar inte för:</p>
        <ul>
          <li>felaktiga bokföringsposter som Kunden har bekräftat,</li>
          <li>konsekvenser av att Kunden inte fullgör sin bokföringsskyldighet,</li>
          <li>
            driftsavbrott orsakade av tredjepartsleverantörer (Supabase, Vercel,
            bankintegrationer),
          </li>
          <li>förlust av data orsakad av Kundens agerande.</li>
        </ul>
        <p>
          5.3. Leverantörens totala skadeståndsansvar under ett kalenderår är begränsat till
          det belopp Kunden har betalat i avgifter under de föregående tolv (12) månaderna.
          Denna begränsning gäller inte vid uppsåt eller grov vårdslöshet.
        </p>
        <p>
          5.4. Leverantören ansvarar aldrig för indirekta skador, utebliven vinst, förlust av
          data utöver vad som anges i avsnitt 8, eller följdskador.
        </p>
      </LegalSection>

      <LegalSection title="6. Priser och betalning">
        <p>
          6.1. Gällande priser och abonnemangsvillkor framgår av Tjänstens prissida vid
          tidpunkten för Kundens registrering eller förnyelse.
        </p>
        <p>
          6.2. Leverantören har rätt att ändra priser med minst trettio (30) dagars varsel
          via e-post till Kunden. Prisändring gäller från nästa faktureringsperiod.
        </p>
        <p>
          6.3. Vid utebliven betalning har Leverantören rätt att begränsa åtkomsten till
          Tjänsten. Kundens data raderas inte under uppsägningstiden eller den
          arkiveringsperiod som anges i avsnitt 8.
        </p>
        <p>
          6.4. Abonnemanget omfattar de volymer som anges på prissidan, till exempel antal
          underlag som Leverantören läser av med AI, skickade e-fakturor, betalningar via
          banken och anslutna bankkonton. Användning utöver det som ingår debiteras enligt
          prissidan.
        </p>
        <p>
          6.5. Gränserna i abonnemanget är mjuka. Leverantören meddelar Kunden innan en
          gräns nås, och avgift för användning utöver det som ingår debiteras först efter
          att Kunden har godkänt den.
        </p>
        <p>
          6.6. Underlag som Kundens egen AI-agent läser av och skickar till Tjänsten som
          strukturerade uppgifter via API eller MCP omfattas inte av avgiften för avläsning.
        </p>
        <p>
          6.7. Priser anges exklusive mervärdesskatt. Ett befintligt abonnemang behåller
          sitt pris tills Leverantören meddelar en ändring enligt punkt 6.2.
        </p>
        <p>
          6.8. Punkterna 6.4 till 6.6 gäller för Kunder som registrerar sig från och med
          den 22 oktober 2026. För Kunder som registrerade sig tidigare gäller de först
          efter meddelande enligt punkt 14.1.
        </p>
      </LegalSection>

      <LegalSection title="7. Immateriella rättigheter">
        <p>
          7.1. Leverantören innehar samtliga immateriella rättigheter till Tjänsten,
          inklusive programvara, gränssnitt, dokumentation och varumärken.
        </p>
        <p>
          7.2. Kunden behåller äganderätten till all data som Kunden registrerar i Tjänsten.
        </p>
        <p>
          7.3. Leverantören erhåller en begränsad licens att behandla Kundens data i den
          utsträckning som krävs för att tillhandahålla Tjänsten.
        </p>
      </LegalSection>

      <LegalSection title="8. Datalagring, arkivering och portabilitet">
        <p>
          8.1. Räkenskapsinformation lagras i minst sju (7) år efter utgången av det
          kalenderår då räkenskapsåret avslutades, i enlighet med 7 kap. 2 § BFL.
        </p>
        <p>
          8.2. Kunden kan när som helst exportera sin Räkenskapsinformation i SIE4-format
          samt ladda ner bilagor och verifikationsunderlag.
        </p>
        <p>8.3. Vid uppsägning av avtalet ska Leverantören:</p>
        <ul>
          <li>
            ge Kunden minst nittio (90) dagar att exportera sin data efter uppsägningsdagens
            utgång,
          </li>
          <li>
            behålla Räkenskapsinformation som omfattas av den sjuåriga
            arkiveringsskyldigheten i skrivskyddat läge till dess att arkiveringsperioden
            löper ut, alternativt tillhandahålla en fullständig dataexport,
          </li>
          <li>
            radera all Kundens data senast trettio (30) dagar efter att arkiveringsperioden
            löpt ut, om inte Kunden begärt radering vid en tidigare tidpunkt och radering
            inte strider mot lagstadgad arkiveringsskyldighet.
          </li>
        </ul>
        <p>
          8.4. Leverantören ska vid Kundens begäran tillhandahålla ett datapaket som innehåller:
        </p>
        <ul>
          <li>SIE4-filer för samtliga räkenskapsår,</li>
          <li>verifikationsunderlag (PDF eller originalformat),</li>
          <li>kundregister och leverantörsregister,</li>
          <li>kontoplan och kontoinställningar.</li>
        </ul>
      </LegalSection>

      <LegalSection title="9. Personuppgiftsbehandling">
        <p>
          9.1. Leverantören behandlar personuppgifter å Kundens vägnar i egenskap av
          personuppgiftsbiträde. Villkoren för denna behandling regleras i ett separat{" "}
          <Link href="/dpa" className={link}>Personuppgiftsbiträdesavtal</Link> som utgör bilaga till dessa Villkor.
        </p>
        <p>
          9.2. Kunden är personuppgiftsansvarig för de personuppgifter som registreras i
          Tjänsten och ansvarar för att det finns rättslig grund för behandlingen.
        </p>
        <p>
          9.3. Leverantören behandlar även vissa personuppgifter i egenskap av
          personuppgiftsansvarig (kontaktuppgifter för kontoadministration, fakturering och
          kommunikation). Denna behandling beskrivs i Leverantörens{" "}
          <Link href="/privacy" className={link}>integritetspolicy</Link>.
        </p>
      </LegalSection>

      <LegalSection title="10. Sekretess">
        <p>
          10.1. Parterna förbinder sig att inte röja konfidentiell information som mottagits
          från den andra parten, med undantag för vad som krävs enligt lag, myndighetsbeslut
          eller för att fullgöra åtaganden enligt detta avtal.
        </p>
        <p>
          10.2. Sekretessåtagandet gäller under avtalstiden och två (2) år därefter.
        </p>
      </LegalSection>

      <LegalSection title="11. Tillgänglighet och support">
        <p>
          11.1. Planerat underhåll aviseras minst tjugofyra (24) timmar i förväg via
          Tjänstens statussida eller e-post.
        </p>
        <p>
          11.2. Support tillhandahålls via de kanaler som anges på Tjänstens webbplats under
          Leverantörens ordinarie öppettider.
        </p>
      </LegalSection>

      <LegalSection title="12. Force majeure">
        <p>
          Leverantören ansvarar inte för bristande uppfyllelse av sina åtaganden om detta
          beror på omständighet utanför Leverantörens kontroll, såsom naturkatastrof, krig,
          myndighetsåtgärd, strömavbrott, telekommunikationsfel eller andra liknande
          omständigheter.
        </p>
      </LegalSection>

      <LegalSection title="13. Avtalstid och uppsägning">
        <p>
          13.1. Avtalet gäller tills vidare med en ömsesidig uppsägningstid om trettio (30) dagar.
        </p>
        <p>
          13.2. Leverantören har rätt att säga upp avtalet med omedelbar verkan om Kunden:
        </p>
        <ul>
          <li>
            väsentligt bryter mot dessa Villkor och inte vidtar rättelse inom fjorton (14)
            dagar efter skriftlig anmaning,
          </li>
          <li>använder Tjänsten i strid med lag,</li>
          <li>inte betalar förfallna avgifter trots påminnelse.</li>
        </ul>
        <p>
          13.3. Vid uppsägning gäller bestämmelserna i avsnitt 8 avseende datalagring och export.
        </p>
      </LegalSection>

      <LegalSection title="14. Ändringar av villkoren">
        <p>
          14.1. Leverantören har rätt att ändra dessa Villkor. Väsentliga ändringar meddelas
          Kunden minst trettio (30) dagar före ikraftträdande via e-post.
        </p>
        <p>
          14.2. Fortsatt användning av Tjänsten efter ändringens ikraftträdande utgör
          godkännande av de nya Villkoren.
        </p>
        <p>
          14.3. Om Kunden inte godkänner ändringen har Kunden rätt att säga upp avtalet i
          enlighet med avsnitt 13 och exportera sin data i enlighet med avsnitt 8.
        </p>
      </LegalSection>

      <LegalSection title="15. Tillämplig lag och tvistlösning">
        <p>
          15.1. Dessa Villkor ska tolkas och tillämpas i enlighet med svensk lag.
        </p>
        <p>
          15.2. Tvist i anledning av dessa Villkor ska i första hand lösas genom förhandling.
          Om parterna inte når en uppgörelse inom trettio (30) dagar ska tvisten avgöras av
          Stockholms tingsrätt som första instans.
        </p>

        <hr />
      </LegalSection>

      <LegalSection title="Bilagor">
        <ul>
          <li>
            Bilaga 1: <Link href="/dpa" className={link}>Personuppgiftsbiträdesavtal</Link>
          </li>
          <li>
            Bilaga 2: <Link href="/privacy" className={link}>Integritetspolicy</Link>
          </li>
          <li>Bilaga 3: Tjänstebeskrivning och SLA (att upprättas)</li>
        </ul>
      </LegalSection>
    </LegalShell>
  )
}
