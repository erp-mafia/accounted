import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalSection, LegalShell, LegalTable } from '@/components/legal/LegalShell'
import { LEGAL_DOCUMENTS, LEGAL_PROVIDER } from '@/lib/legal/documents'

export function generateMetadata(): Metadata {
  return { title: 'Användarvillkor - Accounted' }
}

const link = 'text-primary underline underline-offset-4'

/**
 * Terms, version 2 (published 2026-11-04, written against Fortnox's general
 * terms of 2026-03-03). It binds
 * the customers who sign up from LEGAL_DOCUMENTS.terms.acceptanceVersion
 * (14.4); no notice e-mail goes out (founder decision 2026-11-02), so
 * customers who signed up earlier stay on the wording dated 2026-10-22,
 * published at /terms/2026-10-22, until a notice under 14.1 moves them.
 */
export default function TermsPage() {
  const effective = LEGAL_DOCUMENTS.terms.acceptanceVersion
  return (
    <LegalShell
      title="Användarvillkor"
      subtitle={`Version ${effective}`}
      updatedAt={LEGAL_DOCUMENTS.terms.updatedAt}
    >
      <LegalSection title="1. Parter, målgrupp och definitioner">
        <p>
          1.1 Dessa användarvillkor (&quot;Villkoren&quot;) gäller mellan {LEGAL_PROVIDER.name},
          org.nr {LEGAL_PROVIDER.orgNumber} (&quot;Leverantören&quot;), och den juridiska person
          eller enskilda näringsidkare som registrerar ett konto i Tjänsten (&quot;Kunden&quot;).
        </p>
        <p>
          1.2 Tjänsten tillhandahålls endast till företag och näringsidkare med verksamhet i
          Sverige, för användning i Kundens egen näringsverksamhet. Tjänsten får inte användas
          av konsumenter. Den som registrerar ett konto intygar att hen har behörighet att ingå
          avtal för Kundens räkning.
        </p>
        <p>1.3 I Villkoren betyder:</p>
        <ul>
          <li>
            <strong>Tjänsten</strong>: den molnbaserade bokföringstjänsten Accounted, tillgänglig
            via accounted.se, inklusive funktioner, API, MCP-server, integrationer och tillägg.
          </li>
          <li>
            <strong>Användare</strong>: varje fysisk person som Kunden ger åtkomst till Tjänsten.
          </li>
          <li>
            <strong>Agent</strong>: AI-agent, program, skript eller annan automatiserad klient som
            får åtkomst till Tjänsten via API, MCP, API-nyckel, token eller en Användares
            inloggning.
          </li>
          <li>
            <strong>Automatiserat resultat</strong>: avläsning och tolkning av underlag,
            konteringsförslag, bokföringsposter, momsberäkningar, matchningar och andra resultat
            som Tjänsten tar fram automatiskt, med eller utan AI.
          </li>
          <li>
            <strong>Inlämning</strong>: överföring från Tjänsten till myndighet eller annan tredje
            part, till exempel momsdeklaration och arbetsgivardeklaration till Skatteverket,
            e-faktura och betalningsuppdrag till bank.
          </li>
          <li>
            <strong>Automatisering</strong>: en inställning där Kunden ger Tjänsten eller en Agent
            rätt att bokföra, skicka eller lämna in utan godkännande i varje enskilt fall.
          </li>
          <li>
            <strong>Kunddata</strong>: data som Kunden, Användare eller Agenter för in i Tjänsten
            eller som uppstår genom Kundens användning.
          </li>
          <li>
            <strong>Räkenskapsinformation</strong>: information enligt 1 kap. 2 §
            bokföringslagen (1999:1078).
          </li>
          <li>
            <strong>Tredjepartstjänst</strong>: tjänst som tillhandahålls av annan än Leverantören
            och som Kunden ansluter till Tjänsten, till exempel bank, Agent från tredje part eller
            integration.
          </li>
          <li>
            <strong>Explorativ funktion</strong>: funktion som Leverantören anger är i beta, pilot
            eller test.
          </li>
          <li>
            <strong>Prisbasbelopp</strong>: prisbasbeloppet enligt 2 kap. 7 §
            socialförsäkringsbalken (2010:110) för det år då skadan inträffade.
          </li>
        </ul>
        <p>
          1.4 Vid motstridighet gäller handlingarna i följande ordning: (1) skriftligt
          undertecknat avtal mellan parterna, (2) dessa Villkor, (3) Personuppgiftsbiträdesavtalet,
          (4) övriga bilagor. I frågor om behandling av personuppgifter har dock
          Personuppgiftsbiträdesavtalet företräde framför dessa Villkor.
        </p>
      </LegalSection>

      <LegalSection title="2. Tjänstens omfattning och karaktär">
        <p>
          2.1 Tjänsten tillhandahåller verktyg för löpande bokföring, fakturering,
          leverantörsreskontra, momsdeklaration, bankkoppling och rapportgenerering enligt
          BAS-kontoplanen och svensk redovisningspraxis, samt gränssnitt för Agenter via API och
          MCP.
        </p>
        <p>2.2 Tjänsten stödjer enskild firma och aktiebolag.</p>
        <p>
          2.3 Tjänsten är ett tekniskt hjälpmedel. Leverantören tillhandahåller inte
          redovisningstjänster, skatterådgivning eller revisionstjänster. Support avser endast hur
          Tjänsten fungerar och omfattar inte råd i bokförings- eller skattefrågor. Kunden bär det
          fulla ansvaret för att bokföringen är korrekt och uppfyller lag och god redovisningssed.
        </p>
        <p>
          2.4 Leverantören garanterar inte att Automatiserade resultat är korrekta eller
          fullständiga, eller att Tjänsten uppfyller samtliga lagkrav för Kundens specifika
          verksamhet. Kunden ansvarar för att bedöma Tjänstens lämplighet.
        </p>
        <p>
          2.5 Explorativa funktioner är frivilliga, tillhandahålls i befintligt skick utan
          garantier och kan innehålla fel. Leverantören får när som helst avbryta en Explorativ
          funktion och ansvarar inte för den.
        </p>
        <p>
          2.6 Leverantören får utveckla, ändra och upphöra med funktioner i Tjänsten. En ändring
          som väsentligt försämrar Tjänsten för Kunden meddelas minst trettio (30) dagar i förväg.
          Kunden får då säga upp avtalet till dagen då ändringen träder i kraft och får tillbaka
          förskottsbetald avgift för tiden därefter.
        </p>
      </LegalSection>

      <LegalSection title="3. Konto, Användare, Agenter och API">
        <p>
          3.1 Kunden ansvarar för att uppgifter som lämnas vid registrering är korrekta och hålls
          aktuella.
        </p>
        <p>
          3.2 Kunden ansvarar för att lösenord, API-nycklar och tokens förvaras säkert och att
          obehöriga inte får åtkomst till Tjänsten.
        </p>
        <p>
          3.3 Kunden ansvarar för all aktivitet som sker under Kundens konto, oavsett om den
          utförs av en Användare, en Agent eller en Tredjepartstjänst som Kunden har anslutit.
        </p>
        <p>
          3.4 Kunden bestämmer vilka behörigheter och Automatiseringar som aktiveras. En åtgärd
          som en Agent eller Tjänsten utför med stöd av en sådan behörighet eller Automatisering,
          och en åtgärd som Kunden har godkänt, anses utförd av Kunden.
        </p>
        <p>
          3.5 Tjänsten genomför en Inlämning först när Kunden har godkänt den eller enligt en
          Automatisering som Kunden har aktiverat. Kunden ansvarar för att granska innehållet i
          varje Inlämning före godkännande, och för att följa upp Inlämningar som sker genom
          Automatisering.
        </p>
        <p>
          3.6 Agenter och andra Tredjepartstjänster tillhandahålls av tredje part enligt avtal
          mellan Kunden och den parten. Leverantören ansvarar inte för deras funktion, deras
          agerande eller hur de använder Kunddata.
        </p>
        <p>
          3.7 Ett konto får inte delas mellan flera juridiska personer. Varje bokföringsskyldig
          enhet ska ha ett eget konto.
        </p>
        <p>
          3.8 Leverantören får begränsa eller stänga av åtkomst för en Användare, en Agent eller
          en API-nyckel om det finns risk för skada för Leverantören eller andra kunder, till
          exempel vid misstänkt avtalsbrott, säkerhetsrisk, missbruk eller onormal belastning.
          Leverantören meddelar Kunden utan onödigt dröjsmål.
        </p>
      </LegalSection>

      <LegalSection title="4. Kundens ansvar">
        <p>4.1 Kunden ansvarar för att:</p>
        <ul>
          <li>fullgöra bokföringsskyldigheten enligt bokföringslagen (1999:1078),</li>
          <li>tillämpa god redovisningssed enligt Bokföringsnämndens allmänna råd,</li>
          <li>bokföra affärshändelser inom de tidsfrister som anges i BFNAR 2013:2,</li>
          <li>
            upprätta och underhålla systemdokumentation och behandlingshistorik enligt 5 kap.
            11 § bokföringslagen och BFNAR 2013:2 kapitel 9,
          </li>
          <li>upprätta en arkivplan enligt BFNAR 2013:2 punkt 8.3,</li>
          <li>
            arkivera Räkenskapsinformation enligt 7 kap. bokföringslagen, inklusive efter
            avtalets upphörande,
          </li>
          <li>spara underlag i originalformat när lag kräver det,</li>
          <li>lämna deklarationer och betala skatter och avgifter i rätt tid,</li>
          <li>upprätta årsbokslut eller årsredovisning inom lagstadgad tid.</li>
        </ul>
        <p>
          4.2 Kunden ansvarar för att granska Automatiserade resultat innan de bekräftas, och
          Inlämningar innan de godkänns.
        </p>
        <p>
          4.3 Kunden ansvarar för att inte lagra personuppgifter i Tjänsten utöver vad som krävs
          för bokföringsskyldigheten eller annan rättslig förpliktelse.
        </p>
        <p>
          4.4 Kunden ska använda Tjänsten för dess avsedda syfte och i enlighet med lag, och får
          inte föra in skadlig kod eller material som gör intrång i tredje mans rättigheter.
        </p>
        <p>
          4.5 Kunden ska hålla Leverantören skadeslös för krav från tredje man, inklusive
          myndighet, som uppkommer genom att Kunden, en Användare eller en Agent har använt
          Tjänsten i strid med Villkoren eller lag, eller genom försumlighet.
        </p>
      </LegalSection>

      <LegalSection title="5. Leverantörens åtaganden och tillgänglighet">
        <p>
          5.1 Leverantören ska tillhandahålla Tjänsten fackmässigt och i enlighet med god sed på
          den svenska marknaden.
        </p>
        <p>
          5.2 Leverantören ska vidta tekniska och organisatoriska åtgärder för att skydda Kunddata
          i enlighet med dataskyddsförordningen (EU) 2016/679.
        </p>
        <p>
          5.3 Leverantören ska under avtalstiden göra det möjligt att exportera
          Räkenskapsinformation i SIE4-format.
        </p>
        <p>
          5.4 Leverantören får anlita underleverantörer och ansvarar för deras arbete som för sitt
          eget.
        </p>
        <p>
          5.5 Leverantörens mål är att Tjänsten ska vara tillgänglig 99,5 % per kalendermånad.
          Tillgänglighet mäts som möjligheten att logga in i Tjänsten. Följande räknas inte som
          otillgänglighet:
        </p>
        <ul>
          <li>
            planerat underhåll som aviserats minst tjugofyra (24) timmar i förväg på statussidan
            eller via e-post,
          </li>
          <li>fel i internetförbindelser eller i Kundens utrustning,</li>
          <li>avbrott hos myndigheter, banker och andra Tredjepartstjänster.</li>
        </ul>
        <p>
          5.6 Om tillgängligheten en kalendermånad understiger målet har Kunden rätt till
          prisavdrag på månadsavgiften för den månaden:
        </p>
        <LegalTable
          head={['Tillgänglighet under månaden', 'Prisavdrag']}
          rows={[
            ['99,0 % till under 99,5 %', '10 %'],
            ['97,0 % till under 99,0 %', '25 %'],
            ['Under 97,0 %', '50 %'],
          ]}
        />
        <p>
          Kunden ska begära prisavdrag skriftligen inom sextio (60) dagar efter månadens utgång.
          Prisavdrag är Kundens enda ersättning för bristande tillgänglighet. Understiger
          tillgängligheten 97,0 % tre kalendermånader i följd får Kunden säga upp avtalet med
          omedelbar verkan.
        </p>
      </LegalSection>

      <LegalSection title="6. Fel, reklamation och ansvarsbegränsning">
        <p>
          6.1 Fel föreligger när Tjänsten inte fungerar enligt Villkoren och detta beror på
          Leverantören. Kunden ska anmäla fel till Leverantören inom trettio (30) dagar efter att
          Kunden upptäckte eller borde ha upptäckt felet, och lämna den information som behövs för
          att åtgärda det.
        </p>
        <p>
          6.2 Leverantören ska åtgärda anmälda fel med den skyndsamhet som omständigheterna
          kräver. Om ett fel har lett till felaktigt resultat i bearbetningen av Kunddata ska
          Leverantören utan kostnad bearbeta om eller rätta berörd Kunddata. Detta är Kundens
          första åtgärd vid fel.
        </p>
        <p>6.3 Leverantören ansvarar inte för:</p>
        <ul>
          <li>
            Automatiserade resultat som Kunden har bekräftat eller som har bokförts genom en
            Automatisering,
          </li>
          <li>Inlämningar som Kunden har godkänt eller som har skett genom en Automatisering,</li>
          <li>åtgärder som utförs av Agenter eller Tredjepartstjänster,</li>
          <li>fel, avbrott eller beslut hos myndigheter, banker och andra Tredjepartstjänster,</li>
          <li>
            följder av att Kunden inte fullgör sin bokförings-, deklarations- eller
            betalningsskyldighet,
          </li>
          <li>förlust av data som orsakats av Kunden, en Användare eller en Agent.</li>
        </ul>
        <p>
          6.4 Leverantören ansvarar endast för direkt skada. Leverantörens sammanlagda ansvar
          under en löpande period om tolv (12) månader är begränsat till ett (1) Prisbasbelopp.
        </p>
        <p>6.5 Leverantören ansvarar aldrig för indirekt skada eller följdskada, till exempel:</p>
        <ul>
          <li>utebliven vinst, inkomst eller besparing,</li>
          <li>produktionsbortfall eller avbrott i Kundens verksamhet,</li>
          <li>förlust av data utöver omarbetning enligt 6.2,</li>
          <li>
            skattetillägg, förseningsavgifter, kostnadsränta och andra avgifter, sanktioner eller
            påföljder som myndighet påför Kunden,
          </li>
          <li>krav från tredje man, inklusive Kundens kunder, leverantörer och anställda.</li>
        </ul>
        <p>
          6.6 Begränsningarna i 6.3 till 6.5 gäller inte vid uppsåt eller grov vårdslöshet, eller
          i den mån tvingande lag hindrar dem.
        </p>
        <p>
          6.7 Krav på skadestånd ska framställas skriftligen inom två (2) månader efter att Kunden
          upptäckte eller borde ha upptäckt omständigheten som grundar kravet. Krav som framställs
          senare får inte göras gällande.
        </p>
      </LegalSection>

      <LegalSection title="7. Priser och betalning">
        <p>
          7.1 Gällande priser och abonnemangsvillkor framgår av Tjänstens prissida vid tidpunkten
          för Kundens registrering eller förnyelse. Priser anges exklusive mervärdesskatt.
        </p>
        <p>
          7.2 Leverantören får ändra priser med minst trettio (30) dagars varsel via e-post.
          Ändringen gäller från nästa faktureringsperiod. Ett befintligt abonnemang behåller sitt
          pris tills Leverantören meddelar en ändring enligt denna punkt.
        </p>
        <p>
          7.3 Leverantören får höja priser med omedelbar verkan om höjningen beror på
          omständigheter utanför Leverantörens kontroll, till exempel ändrade skatter eller
          avgifter, valutakurser eller väsentligt ändrade kostnader hos underleverantörer. Kunden
          får då säga upp avtalet till dagen då höjningen träder i kraft.
        </p>
        <p>
          7.4 Abonnemanget omfattar de volymer som anges på prissidan, till exempel antal underlag
          som Leverantören läser av med AI, skickade e-fakturor, betalningar via banken och
          anslutna bankkonton. Användning utöver det som ingår debiteras enligt prissidan.
        </p>
        <p>
          7.5 Gränserna i abonnemanget är mjuka. Leverantören meddelar Kunden innan en gräns nås,
          och avgift för användning utöver det som ingår debiteras först efter att Kunden har
          godkänt den.
        </p>
        <p>
          7.6 Underlag som Kundens egen Agent läser av och skickar till Tjänsten som strukturerade
          uppgifter via API eller MCP omfattas inte av avgiften för avläsning.
        </p>
        <p>
          7.7 Betalning sker enligt de villkor som anges på fakturan eller vid kortbetalning. Vid
          försenad betalning har Leverantören rätt till dröjsmålsränta enligt räntelagen
          (1975:635) och påminnelseavgift. Vid utebliven betalning får Leverantören begränsa
          åtkomsten till Tjänsten. Kunddata raderas inte medan åtkomsten är begränsad.
        </p>
        <p>
          7.8 Förskottsbetalda avgifter återbetalas endast i fall som anges i 2.6, 7.3 och 13.3.
        </p>
        <p>
          7.9 Punkterna 7.4 till 7.6 gäller för Kunder som registrerat sig från och med den 22
          oktober 2026. För Kunder som registrerat sig tidigare gäller de först efter meddelande
          enligt 14.1.
        </p>
      </LegalSection>

      <LegalSection title="8. Immateriella rättigheter och öppen källkod">
        <p>
          8.1 Programvaran bakom Tjänsten är öppen källkod och licensieras under GNU Affero
          General Public License v3.0 (AGPL-3.0). Villkoren begränsar inte de rättigheter som
          licensen ger. Källkoden finns tillgänglig via länken på accounted.se.
        </p>
        <p>
          8.2 Leverantören innehar varumärket Accounted samt rättigheterna till den drift,
          infrastruktur och det material som Leverantören tillhandahåller som Tjänsten och som
          inte har publicerats under öppen licens.
        </p>
        <p>
          8.3 Under avtalstiden har Kunden en icke-exklusiv rätt, som inte får överlåtas, att
          använda Tjänsten i sin egen verksamhet och att låta Användare och Agenter göra det.
        </p>
        <p>8.4 Kunden äger all Kunddata.</p>
        <p>
          8.5 Leverantören får behandla Kunddata i den utsträckning som krävs för att
          tillhandahålla, säkra och felsöka Tjänsten. Leverantören får använda aggregerade och
          anonymiserade mönster ur Kunddata, som inte kan hänföras till Kunden eller till en
          enskild person, för att förbättra Tjänstens förslag och övriga funktioner, inklusive
          funktioner som bygger på AI. Kunden kan när som helst stänga av detta under
          Inställningar, avsnittet Datadelning och AI. Övrig Kunddata, till exempel verifikationer
          och underlag, används för att utvärdera eller förbättra Tjänsten endast om Kunden har
          medgett det i samma avsnitt. Leverantören säljer inte Kunddata och lämnar inte ut den
          för tredje parts marknadsföring.
        </p>
      </LegalSection>

      <LegalSection title="9. Kunddata, export och lagring efter upphörande">
        <p>
          9.1 Kunden kan under avtalstiden när som helst exportera sin Räkenskapsinformation i
          SIE4-format och ladda ner underlag och verifikationer.
        </p>
        <p>
          9.2 Tjänsten ersätter inte Kundens skyldighet att arkivera Räkenskapsinformation enligt
          7 kap. bokföringslagen. Kunden ansvarar för att exportera den Kunddata som Kunden
          behöver innan avtalet upphör.
        </p>
        <p>
          9.3 Efter avtalets upphörande behåller Leverantören Kunddata i skrivskyddat läge i
          arton (18) månader. Under denna tid kan Kunden exportera sin data. Därefter upphör all
          åtkomst och Kunddata raderas eller anonymiseras. Räkenskapsinformation som omfattas av
          arkiveringstiden i 7 kap. 2 § bokföringslagen spärras i stället och raderas när
          arkiveringstiden har löpt ut. Under spärrtiden lämnar Leverantören ut
          Räkenskapsinformationen på Kundens skriftliga begäran till {LEGAL_PROVIDER.email}.
        </p>
        <p>
          9.4 På Kundens begäran, under avtalstiden eller perioden i 9.3, tillhandahåller
          Leverantören ett datapaket med:
        </p>
        <ul>
          <li>SIE4-filer för samtliga räkenskapsår,</li>
          <li>verifikationsunderlag i PDF eller originalformat,</li>
          <li>kundregister och leverantörsregister,</li>
          <li>kontoplan och kontoinställningar.</li>
        </ul>
        <p>Leverantören informerar om eventuell kostnad innan datapaketet tas fram.</p>
        <p>
          9.5 Vid byte av leverantör bistår Leverantören Kunden i den utsträckning som följer av
          dataförordningen (EU) 2023/2854.
        </p>
        <p>
          9.6 Kunden kan begära att Kunddata raderas tidigare än enligt 9.3, om radering inte
          strider mot lag.
        </p>
      </LegalSection>

      <LegalSection title="10. Personuppgifter och underbiträden">
        <p>
          10.1 Leverantören behandlar personuppgifter för Kundens räkning som
          personuppgiftsbiträde. Behandlingen regleras i{' '}
          <Link href="/dpa" className={link}>
            Personuppgiftsbiträdesavtalet
          </Link>{' '}
          (Bilaga 1).
        </p>
        <p>
          10.2 Kunden är personuppgiftsansvarig för personuppgifter i Tjänsten och ansvarar för
          att det finns rättslig grund för behandlingen.
        </p>
        <p>
          10.3 Leverantören är personuppgiftsansvarig för kontaktuppgifter som används för
          kontoadministration, fakturering och kommunikation. Denna behandling beskrivs i{' '}
          <Link href="/privacy" className={link}>
            integritetspolicyn
          </Link>{' '}
          (Bilaga 2).
        </p>
        <p>
          10.4 Kunddata lagras primärt inom EU/EES. Kunden godkänner att Leverantören anlitar de
          underbiträden som anges i Personuppgiftsbiträdesavtalet (
          <Link href="/subprocessors" className={link}>
            förteckning över underbiträden
          </Link>
          ), inom och utanför EU/EES. Överföring utanför EU/EES sker endast med giltig grund
          enligt dataskyddsförordningen, till exempel EU-kommissionens standardavtalsklausuler
          eller EU-U.S. Data Privacy Framework.
        </p>
        <p>
          10.5 Leverantören meddelar nya eller ersatta underbiträden genom att uppdatera
          förteckningen. Kunden kan invända skriftligen inom trettio (30) dagar. Om invändningen
          är befogad och Leverantören ändå anlitar underbiträdet får Kunden säga upp avtalet utan
          kostnad.
        </p>
      </LegalSection>

      <LegalSection title="11. Sekretess">
        <p>
          11.1 Parterna ska inte röja konfidentiell information som mottagits från den andra
          parten, utom när det krävs enligt lag, domstols- eller myndighetsbeslut, eller för att
          fullgöra avtalet. Information som är allmänt tillgänglig eller som parten redan kände
          till utan sekretessåtagande omfattas inte.
        </p>
        <p>
          11.2 Parterna ska se till att anställda och underleverantörer som får del av
          konfidentiell information är bundna av motsvarande sekretess.
        </p>
        <p>11.3 Sekretessåtagandet gäller under avtalstiden och två (2) år därefter.</p>
      </LegalSection>

      <LegalSection title="12. Force majeure">
        <p>
          12.1 Part ansvarar inte för bristande uppfyllelse som beror på omständighet utanför
          partens kontroll som parten inte rimligen kunnat förutse, till exempel naturkatastrof,
          krig, pandemi, myndighetsåtgärd, ny lagstiftning, arbetskonflikt, strömavbrott, fel i
          allmänna kommunikationsnät eller omfattande cyberangrepp som inte rimligen kunnat
          förhindras.
        </p>
        <p>
          12.2 Pågår en sådan omständighet längre än nittio (90) dagar får vardera part säga upp
          avtalet med omedelbar verkan.
        </p>
      </LegalSection>

      <LegalSection title="13. Avtalstid och uppsägning">
        <p>
          13.1 Avtalet gäller tills vidare med en ömsesidig uppsägningstid om trettio (30) dagar.
        </p>
        <p>13.2 Leverantören får säga upp avtalet med omedelbar verkan om Kunden:</p>
        <ul>
          <li>
            väsentligt bryter mot Villkoren och inte vidtar rättelse inom fjorton (14) dagar efter
            skriftlig anmaning,
          </li>
          <li>använder Tjänsten i strid med lag,</li>
          <li>inte betalar förfallna avgifter trots påminnelse,</li>
          <li>
            försätts i konkurs, inleder likvidation, ställer in betalningarna eller annars kan
            antas vara på obestånd.
          </li>
        </ul>
        <p>
          13.3 Kunden får säga upp avtalet med omedelbar verkan om Leverantören väsentligt bryter
          mot Villkoren och inte vidtar rättelse inom trettio (30) dagar efter skriftlig anmaning.
          Leverantören återbetalar då förskottsbetald avgift för tiden efter upphörandet.
        </p>
        <p>
          13.4 Vid upphörande gäller avsnitt 9. Avsnitten 4.5, 6, 9, 10, 11 och 17 gäller även
          efter avtalets upphörande.
        </p>
      </LegalSection>

      <LegalSection title="14. Ändringar av Villkoren">
        <p>
          14.1 Leverantören får ändra Villkoren. Väsentliga ändringar meddelas via e-post minst
          trettio (30) dagar innan de träder i kraft.
        </p>
        <p>
          14.2 Fortsatt användning av Tjänsten efter att en ändring trätt i kraft innebär att
          Kunden godkänner ändringen.
        </p>
        <p>
          14.3 Kunden som inte godkänner en väsentlig ändring får säga upp avtalet till dagen då
          ändringen träder i kraft och exportera sin data enligt avsnitt 9.
        </p>
        <p>
          14.4 Dessa Villkor gäller för Kunder som ingår avtal från och med den {effective}. För
          Kunder som ingick avtal dessförinnan gäller de{' '}
          <Link href="/terms/2026-10-22" className={link}>
            tidigare villkoren
          </Link>{' '}
          tills Leverantören meddelar en ändring enligt 14.1.
        </p>
      </LegalSection>

      <LegalSection title="15. Överlåtelse">
        <p>15.1 Kunden får inte överlåta avtalet utan Leverantörens skriftliga medgivande.</p>
        <p>
          15.2 Leverantören får överlåta avtalet, helt eller delvis, till ett koncernbolag eller
          till den som övertar hela eller delar av Leverantörens verksamhet. Leverantören meddelar
          Kunden om överlåtelsen.
        </p>
      </LegalSection>

      <LegalSection title="16. Meddelanden">
        <p>
          16.1 Leverantören lämnar meddelanden via Tjänsten eller via e-post till den adress
          Kunden senast angett. Meddelanden via Tjänsten eller e-post anses mottagna samma dag som
          de skickas.
        </p>
        <p>
          16.2 Kunden lämnar meddelanden till{' '}
          <a href={`mailto:${LEGAL_PROVIDER.email}`} className={link}>
            {LEGAL_PROVIDER.email}
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection title="17. Tillämplig lag och tvistlösning">
        <p>17.1 Villkoren ska tolkas och tillämpas enligt svensk lag.</p>
        <p>
          17.2 Tvist ska i första hand lösas genom förhandling. Om parterna inte når en
          uppgörelse inom trettio (30) dagar avgörs tvisten av Stockholms tingsrätt som första
          instans.
        </p>
      </LegalSection>

      <LegalSection title="Bilagor">
        <ul>
          <li>
            Bilaga 1:{' '}
            <Link href="/dpa" className={link}>
              Personuppgiftsbiträdesavtal
            </Link>
            , inklusive{' '}
            <Link href="/subprocessors" className={link}>
              förteckning över underbiträden
            </Link>
          </li>
          <li>
            Bilaga 2:{' '}
            <Link href="/privacy" className={link}>
              Integritetspolicy
            </Link>
          </li>
        </ul>
      </LegalSection>
    </LegalShell>
  )
}
