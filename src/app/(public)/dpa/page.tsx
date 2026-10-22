import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalSection, LegalShell, LegalTable } from '@/components/legal/LegalShell'
import { LEGAL_DOCUMENTS, LEGAL_PROVIDER } from '@/lib/legal/documents'

export function generateMetadata(): Metadata {
  return { title: 'Personuppgiftsbiträdesavtal - Accounted' }
}

const link = 'text-primary underline underline-offset-4'

export default function DPAPage() {
  return (
    <LegalShell
      title="Personuppgiftsbiträdesavtal"
      subtitle={`Enligt artikel 28 i dataskyddsförordningen (GDPR) · Version ${LEGAL_DOCUMENTS.dpa.acceptanceVersion}`}
      updatedAt={LEGAL_DOCUMENTS.dpa.updatedAt}
    >
      <LegalSection title="1. Parter och avtalets ingående">
        <ul>
          <li>
            <strong>Personuppgiftsansvarig (&quot;Kunden&quot;):</strong> det företag som använder
            Accounted (&quot;Tjänsten&quot;) och har godkänt{' '}
            <Link href="/terms" className={link}>
              användarvillkoren
            </Link>
            .
          </li>
          <li>
            <strong>Personuppgiftsbiträde (&quot;Biträdet&quot;):</strong> {LEGAL_PROVIDER.name},
            org.nr {LEGAL_PROVIDER.orgNumber}, {LEGAL_PROVIDER.address}.
          </li>
        </ul>
        <p>
          Avtalet är en bilaga till användarvillkoren och gäller när Kunden har godkänt det i
          Tjänsten; Tjänsten sparar vem som godkände vilken version och när. Använder Kunden Tjänsten för ett annat företags räkning, till exempel som
          redovisningsbyrå för sina klienter, ansvarar Kunden för att ha rätt att ge instruktionerna
          i detta avtal för det företaget.
        </p>
      </LegalSection>

      <LegalSection title="2. Instruktioner">
        <p>
          Biträdet behandlar personuppgifter endast enligt Kundens dokumenterade instruktioner,
          också när det gäller överföring till tredje land, om inte unionsrätten eller svensk rätt
          kräver annat. Biträdet informerar då Kunden om kravet innan behandlingen, om inte lagen
          förbjuder det. Anser Biträdet att en instruktion strider mot dataskyddsreglerna informerar
          Biträdet Kunden omedelbart.
        </p>
        <p>
          Kundens instruktioner är detta avtal, de funktioner Kunden använder och de val Kunden gör
          i Tjänsten. Biträdet behandlar personuppgifter för att:
        </p>
        <ul>
          <li>lagra och bearbeta bokföringen: verifikationer, fakturor, kund- och leverantörsregister, underlag och rapporter;</li>
          <li>hämta banktransaktioner och initiera betalningar som Kunden godkänner, via licensierade betaltjänstleverantörer;</li>
          <li>ta emot underlag som Kunden laddar upp, mejlar till Tjänstens inkorgsadresser, skickar via WhatsApp eller låter Tjänsten hämta från en kopplad brevlåda;</li>
          <li>beräkna löner, skicka lönebesked och lämna arbetsgivardeklarationer;</li>
          <li>lämna deklarationer och andra uppgifter till Skatteverket och Bolagsverket när Kunden skickar in dem;</li>
          <li>skicka och ta emot fakturor via e-post och Peppol;</li>
          <li>
            lämna fakturor till påminnelse och inkasso, och skicka fakturor, via ett inkasso- och
            utskicksföretag som Kunden själv aktiverar (se punkt 6);
          </li>
          <li>använda AI för att föreslå kontering, läsa av underlag och svara i assistenten (se punkt 5);</li>
          <li>föra in motparter som är företag eller myndigheter i en gemensam motpartskatalog, och ta fram anonymiserad statistik (se punkt 5);</li>
          <li>ge Kundens egna agenter och integrationer åtkomst via API-nycklar som Kunden skapar;</li>
          <li>exportera, säkerhetskopiera och, vid avtalets slut, återlämna eller radera uppgifterna (se punkt 13).</li>
        </ul>
      </LegalSection>

      <LegalSection title="3. Personuppgifter och registrerade">
        <LegalTable
          head={['Registrerade', 'Uppgifter']}
          rows={[
            [
              'Kundens kunder',
              'Namn, adress, e-post, telefon, organisationsnummer; för privatpersoner även personnummer; fakturor och betalningar',
            ],
            [
              'Kundens leverantörer',
              'Namn, adress, organisationsnummer, bankgiro, plusgiro och bankkonto, fakturor och betalningar',
            ],
            [
              'Kundens anställda',
              'Namn, personnummer, adress, bankkonto, anställningsvillkor, lön, förmåner, skatteavdrag, frånvaro (till exempel sjukfrånvaro, föräldraledighet och vård av barn), löneavdrag som fackavgift, samt lönebesked och arbetsgivardeklarationer',
            ],
            [
              'Kundens ägare, styrelse och firmatecknare',
              'Namn, personnummer, roll och kontaktuppgifter, när de behövs för signering, deklarationer och årsredovisning, och, om Kunden aktiverar inkasso och utskick, de uppgifter om ägare, ledning och firmatecknare som behövs för kundkännedom och signering',
            ],
            [
              'Andra personer i underlagen',
              'Det som framgår av kvitton, fakturor, banktexter och anteckningar, till exempel deltagare vid representation',
            ],
          ]}
        />
        <p>
          <strong>Känsliga personuppgifter.</strong> Lönehanteringen innehåller uppgifter om hälsa
          (sjukfrånvaro) och kan visa medlemskap i fackförening (fackavgift som löneavdrag). Kunden
          behandlar dem för att fullgöra sina skyldigheter som arbetsgivare (art. 9.2 b och 3 kap.
          2 § dataskyddslagen). Tjänsten frågar aldrig efter diagnoser. Lönebesked skickas som
          personliga länkar, aldrig som bilagor i e-post. Kunden ska inte registrera andra känsliga
          personuppgifter eller uppgifter om lagöverträdelser i fritextfält.
        </p>
      </LegalSection>

      <LegalSection title="4. Konfidentialitet">
        <p>
          Biträdet säkerställer att de som har behörighet att behandla personuppgifterna har åtagit
          sig konfidentialitet eller omfattas av lagstadgad tystnadsplikt, och att åtkomst ges bara
          till den som behöver den för att fullgöra Biträdets åtaganden, till exempel för att lösa
          ett supportärende som Kunden har öppnat.
        </p>
      </LegalSection>

      <LegalSection title="5. AI, gemensam motpartskatalog och statistik">
        <p>
          <strong>AI.</strong> AI-funktionerna körs inom EU via Amazon Bedrock. Underlag och
          bokföringsdata skickas dit endast för den uppgift som ska utföras, lagras inte där efter
          anropet och används inte för att träna modeller. AI-förslag bokförs inte utan att Kunden,
          eller en agent som Kunden själv har kopplat, godkänner dem. Kunden kan stänga av
          AI-funktionerna i Tjänsten; då skickas inget av Kundens innehåll till AI-tjänsten.
        </p>
        <p>
          <strong>Gemensam motpartskatalog.</strong> När minst två företag oberoende av varandra har
          tolkat samma banktext som samma motpart av typen handlare, myndighet, bank eller
          betalväxel, för Biträdet in motpartens namn och typ i en katalog som förbättrar tolkningen
          för alla kunder. Katalogen innehåller inte vilka företag tolkningen kom från och aldrig
          privatpersoner. Kunden kan stänga av sin medverkan i Tjänsten.
        </p>
        <p>
          <strong>Anonymiserad statistik.</strong> Kunden ger Biträdet i uppdrag att ta fram
          anonymiserad statistik om hur konteringsförslag stämmer: föreslaget och bokfört
          BAS-konto och modellens säkerhet, utan företags-ID, belopp eller fritext. Resultatet är
          inte personuppgifter. Biträdet använder inte Kundens bokföring i utvärderingskörningar
          eller för att träna modeller, om inte Kunden har slagit på Bidra med innehåll i Tjänsten
          eller har ett separat skriftligt avtal med Biträdet om det. För sådan användning är
          Biträdet personuppgiftsansvarigt; Biträdet tar bort personnummer innan uppgifterna
          används, behandlar dem inom EU och slutar använda dem när Kunden stänger av funktionen.
        </p>
      </LegalSection>

      <LegalSection title="6. Underbiträden">
        <p>
          Kunden ger Biträdet ett allmänt förhandsgodkännande att anlita underbiträden. Den aktuella{' '}
          <Link href="/subprocessors" className={link}>
            förteckningen över underbiträden
          </Link>{' '}
          med namn, ändamål, plats och skyddsmekanism är en del av detta avtal.
        </p>
        <p>
          Biträdet meddelar Kunden via e-post minst 30 dagar innan ett underbiträde läggs till eller
          byts ut. Kunden kan invända inom den tiden. Kan parterna inte enas har Kunden rätt att
          säga upp avtalet utan kostnad innan ändringen börjar gälla, och att exportera sina
          uppgifter enligt punkt 13.
        </p>
        <p>
          Biträdet ålägger varje underbiträde samma dataskyddsskyldigheter som i detta avtal genom
          skriftligt avtal, och förblir fullt ansvarigt gentemot Kunden för underbiträdets
          fullgörande.
        </p>
        <p>
          <strong>Mottagare som Kunden själv väljer</strong> är inte underbiträden: Skatteverket,
          Bolagsverket och Kundens bank, liksom tjänster Kunden kopplar med egna konton (till exempel
          Google Drive, Dropbox, Gmail, Stripe, Shopify, WooCommerce, Zettle eller ett tidigare
          bokföringsprogram) och Kundens egna AI-agenter. Biträdet lämnar eller hämtar uppgifter till
          och från dem endast enligt Kundens instruktion.
        </p>
        <p>
          <strong>Inkasso- och utskicksföretag som Kunden aktiverar.</strong> Kunden kan i Tjänsten
          aktivera ett inkasso- och utskicksföretag för utskick av fakturor och för påminnelser och
          inkasso. Företaget anlitas inte av Biträdet och är inte Biträdets underbiträde: Kunden
          ingår själv avtal med företaget när kopplingen aktiveras, och de villkor och, i
          förekommande fall, det personuppgiftsbiträdesavtal som Kunden då godkänner anger om
          företaget behandlar uppgifterna som självständigt personuppgiftsansvarig eller som
          Kundens personuppgiftsbiträde. Det företag som Kunden i dag kan aktivera är Kravia AB
          (org.nr 556564-1106), för påminnelser och inkasso; enligt bolagets integritetspolicy är
          Kravia AB personuppgiftsansvarig för den behandling bolaget utför i sin
          inkassoverksamhet. Kundens aktivering och val enligt nedan utgör dokumenterade
          instruktioner enligt punkt 2, och Biträdet lämnar uppgifter till företaget endast enligt
          dem:
        </p>
        <ul>
          <li>
            När Kunden skickar in ansökan, godkänner villkoren och låter avtalet signeras: Kundens
            företagsuppgifter, kontaktuppgifter och utbetalningskonto, svar på frågor om
            kundkännedom, namnet på den som godkänner villkoren, firmatecknarens e-post om
            signeringslänken ska skickas dit och, för en enskild firma, ägarens personnummer.
          </li>
          <li>
            När Kunden skickar en faktura via företaget, lämnar över den till påminnelse eller
            inkasso, ställer in ett återkommande fakturaschema att skicka via företaget eller
            godkänner en sammanställd omgång: fakturan med de betalningar och krediteringar som
            redan finns på den, och uppgifter om kunden (namn, postadress, e-post och telefonnummer
            när de finns, samt organisationsnummer eller, för privatpersoner, personnummer).
          </li>
          <li>
            När Kunden väljer en utskickskanal för en kund: kundens organisationsnummer eller
            personnummer, för att kontrollera att kunden kan nås i den kanalen.
          </li>
          <li>
            Så länge företaget har ett öppet ärende för en faktura: betalningar och kreditfakturor
            som avser fakturan, och Kundens åtgärder i ärendet, till exempel paus, återkallelse
            eller bestridande, med eventuellt meddelande från Kunden. Om en rapporterad betalning
            senare tas bort eller ändras meddelas det också, även efter att ärendet har avslutats.
            Ärendets status, händelser och avräkningar hämtas tillbaka till Tjänsten.
          </li>
        </ul>
        <p>
          Inga uppgifter lämnas till företaget innan Kunden har godkänt företagets villkor och
          skickat in ansökan om aktivering.
        </p>
      </LegalSection>

      <LegalSection title="7. Säkerhet">
        <p>
          Biträdet vidtar lämpliga tekniska och organisatoriska åtgärder enligt artikel 32 GDPR, med
          hänsyn till att bokföring och löner innehåller ekonomiska uppgifter, personnummer och
          känsliga personuppgifter. Åtgärderna beskrivs i bilaga B.
        </p>
      </LegalSection>

      <LegalSection title="8. Bistånd med de registrerades rättigheter">
        <p>
          Biträdet bistår Kunden, genom lämpliga tekniska och organisatoriska åtgärder och i den mån
          det är möjligt, så att Kunden kan besvara begäranden om tillgång, rättelse, radering,
          begränsning, dataportabilitet och invändning. Tjänsten har export (SIE4, JSON, CSV) och
          rättelse och radering av register som stöd. Riktar en registrerad sin begäran direkt till
          Biträdet vidarebefordrar Biträdet den till Kunden utan onödigt dröjsmål och besvarar den
          inte själv.
        </p>
      </LegalSection>

      <LegalSection title="9. Personuppgiftsincidenter">
        <p>
          Biträdet underrättar Kunden utan onödigt dröjsmål och senast 24 timmar efter att Biträdet
          upptäckt en personuppgiftsincident som rör Kundens uppgifter. Underrättelsen innehåller,
          så långt det är känt: vad som hänt, vilka kategorier och ungefär hur många registrerade och
          poster som berörs, sannolika konsekvenser, vidtagna och föreslagna åtgärder, samt
          kontaktperson hos Biträdet. Information som inte finns direkt lämnas så snart den finns.
          Biträdet bistår Kunden med anmälan till Integritetsskyddsmyndigheten (art. 33) och med
          information till de registrerade (art. 34).
        </p>
      </LegalSection>

      <LegalSection title="10. Konsekvensbedömning och förhandssamråd">
        <p>
          Biträdet bistår Kunden vid konsekvensbedömningar (art. 35) och förhandssamråd med
          Integritetsskyddsmyndigheten (art. 36) med den information Biträdet har om sin behandling,
          bland annat en beskrivning av Tjänsten, dess säkerhetsåtgärder och underbiträden.
        </p>
      </LegalSection>

      <LegalSection title="11. Granskning">
        <p>
          Biträdet ger Kunden den information som behövs för att visa att skyldigheterna i artikel
          28 uppfylls, och möjliggör och bidrar till granskningar, inklusive inspektioner, som Kunden
          eller en oberoende granskare som Kunden utsett genomför. Granskning aviseras minst 30 dagar
          i förväg, sker under kontorstid utan att i onödan störa verksamheten och bekostas av
          Kunden. Biträdet får i första hand erbjuda skriftlig dokumentation eller en
          tredjepartsgranskning.
        </p>
      </LegalSection>

      <LegalSection title="12. Överföring till tredje land">
        <p>
          Databas, inloggning och uppladdade filer lagras i Sverige (Stockholm), och Tjänstens
          serverfunktioner körs i samma region. Räkenskapsinformation som förvaras i Tjänsten
          förvaras därmed i Sverige (7 kap. 2 § bokföringslagen). AI-anropen behandlas inom EU och
          innebär ingen lagring utanför Sverige. Där ett underbiträde överför uppgifter till tredje
          land framgår skyddsmekanismen av förteckningen över underbiträden, och Biträdet
          tillhandahåller dokumentation om varje överföring på begäran.
        </p>
      </LegalSection>

      <LegalSection title="13. Export, återlämnande och radering">
        <p>
          Kunden kan när som helst exportera bokföringen (SIE4 och fullständigt arkiv med underlag)
          och register (CSV). Biträdet hindrar aldrig export, inte heller vid obetalda avgifter.
        </p>
        <p>
          När avtalet upphör väljer Kunden mellan att Biträdet:
        </p>
        <ul>
          <li>
            <strong>bevarar</strong> räkenskapsinformationen skrivskyddad och exporterbar under
            bokföringslagens lagringstid och därefter raderar den, vilket gäller om Kunden inte
            väljer annat; eller
          </li>
          <li>
            <strong>raderar</strong> övriga uppgifter senast 30 dagar efter Kundens skriftliga
            begäran till {LEGAL_PROVIDER.email}, efter att Kunden har exporterat det Kunden
            behöver.
          </li>
        </ul>
        <p>
          Skyldigheten att bevara räkenskapsinformation i sju år enligt bokföringslagen ligger på
          Kunden. Tjänstens skydd för bokförda verifikationer och deras underlag medger inte att de
          raderas före lagringstidens slut; vill Kunden ändå att Biträdet raderar dem tidigare, efter
          att Kunden själv har ordnat bevarandet, sker det efter särskild överenskommelse.
          Säkerhetskopior skrivs över enligt sin egen cykel och används endast för
          katastrofåterställning.
        </p>
      </LegalSection>

      <LegalSection title="14. Avtalstid, ansvar och kontakt">
        <p>
          Avtalet gäller så länge Biträdet behandlar personuppgifter för Kundens räkning. Biträdets
          ansvar regleras av ansvarsbegränsningen i användarvillkoren; sanktionsavgifter som en
          tillsynsmyndighet beslutar bärs av den part som avgiften gäller. Kontakt i dataskyddsfrågor:{' '}
          {LEGAL_PROVIDER.email}.
        </p>
      </LegalSection>

      <LegalSection title="Bilaga A: Behandlingens specifikation">
        <LegalTable
          head={['', '']}
          rows={[
            ['Ändamål', 'Tillhandahålla Tjänsten enligt punkt 2'],
            ['Behandlingens art', 'Insamling, lagring, bearbetning, överföring till mottagare som Kunden valt, export och radering'],
            ['Personuppgifter och registrerade', 'Enligt punkt 3, inklusive känsliga personuppgifter i lönehanteringen'],
            ['Varaktighet', 'Avtalstiden och, om Kunden inte väljer radering, bokföringslagens lagringstid därefter'],
            ['Plats', 'Sverige för lagring och drift; EU för AI-anrop; i övrigt enligt förteckningen över underbiträden'],
          ]}
        />
      </LegalSection>

      <LegalSection title="Bilaga B: Tekniska och organisatoriska åtgärder">
        <ul>
          <li>
            <strong>Inloggning:</strong> e-post och lösenord (lagras endast som saltad hash) med
            tvåfaktorsautentisering via TOTP, eller BankID. Automatisk utloggning efter inaktivitet
            kan slås på per användare.
          </li>
          <li>
            <strong>Åtkomstkontroll:</strong> Row Level Security i databasen avgränsar varje
            företags data till dess medlemmar och deras roller. API-nycklar lagras endast som
            SHA-256-hash och har avgränsade behörigheter.
          </li>
          <li>
            <strong>Kryptering:</strong> TLS för all trafik och AES-256 i vila. Personnummer i
            person- och kundregistren och åtkomstnycklar till banker och andra tjänster krypteras
            dessutom i applikationen med AES-256-GCM.
          </li>
          <li>
            <strong>Bokföringens integritet:</strong> databasutlösare hindrar ändring och radering
            av bokförda verifikationer, verifikationsnummer tilldelas i obruten följd, rättelser
            loggas med vem och när, och dokument får SHA-256-kontrollsummor.
          </li>
          <li>
            <strong>Säkerhetskopiering:</strong> automatiska dagliga säkerhetskopior av databasen.
          </li>
          <li>
            <strong>Missbruksskydd:</strong> begränsning av antalet anrop per IP-adress, användare
            och API-nyckel.
          </li>
          <li>
            <strong>Loggning och incidenter:</strong> loggning av inloggning och behörighetsfel,
            revisionslogg för bokföringshändelser och en dokumenterad incidentrutin.
          </li>
          <li>
            <strong>Personal:</strong> åtkomst till produktionsmiljön endast för behörig personal
            med sekretessåtagande.
          </li>
        </ul>
      </LegalSection>
    </LegalShell>
  )
}
