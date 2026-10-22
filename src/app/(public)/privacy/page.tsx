import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalSection, LegalShell, LegalTable } from '@/components/legal/LegalShell'
import { RecipientTable } from '@/components/legal/RecipientTable'
import { LEGAL_DOCUMENTS, LEGAL_PROVIDER } from '@/lib/legal/documents'

export function generateMetadata(): Metadata {
  return { title: 'Integritetspolicy - Accounted' }
}

const link = 'text-primary underline underline-offset-4'

export default function PrivacyPolicyPage() {
  return (
    <LegalShell title="Integritetspolicy" updatedAt={LEGAL_DOCUMENTS.privacy.updatedAt}>
      <LegalSection title="1. Vem som ansvarar">
        <p>
          Den här policyn beskriver hur {LEGAL_PROVIDER.name} (&quot;vi&quot;) behandlar
          personuppgifter när du använder Accounted (app.accounted.se, tjänstens API och MCP-server)
          och när du besöker accounted.se.
        </p>
        <ul>
          <li>
            <strong>Personuppgiftsansvarig:</strong> {LEGAL_PROVIDER.name}, org.nr{' '}
            {LEGAL_PROVIDER.orgNumber}
          </li>
          <li>
            <strong>Adress:</strong> {LEGAL_PROVIDER.address}
          </li>
          <li>
            <strong>E-post, även för dataskyddsfrågor:</strong> {LEGAL_PROVIDER.email}
          </li>
        </ul>
        <p>
          Vi har inte utsett något dataskyddsombud. Alla frågor om dataskydd skickar du till
          adressen ovan.
        </p>
      </LegalSection>

      <LegalSection title="2. Två roller">
        <ul>
          <li>
            <strong>Personuppgiftsansvariga</strong> är vi för uppgifter om dig som användare,
            kontaktperson och besökare. Det är den behandlingen som beskrivs här.
          </li>
          <li>
            <strong>Personuppgiftsbiträde</strong> är vi för de uppgifter som ditt företag lägger in
            i bokföringen: kunder, leverantörer, anställda och andra personer i verifikationer,
            fakturor och löner. Ditt företag är personuppgiftsansvarigt för dem, och vår behandling
            styrs av{' '}
            <Link href="/dpa" className={link}>
              personuppgiftsbiträdesavtalet
            </Link>
            . Har du frågor om uppgifter i ett visst företags bokföring vänder du dig i första hand
            till det företaget.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="3. Vad vi behandlar, varför och hur länge">
        <LegalTable
          head={['Uppgifter', 'Ändamål', 'Rättslig grund', 'Lagringstid']}
          rows={[
            [
              'E-postadress, namn, lösenord (lagras endast som saltad hash), nyckel för tvåfaktorsinloggning, inloggningssessioner, språkval',
              'Skapa och driva ditt konto, logga in dig',
              'Avtal (art. 6.1 b)',
              'Tills du raderar kontot',
            ],
            [
              'Vid BankID-inloggning: personnummer (lagras krypterat), namn och vilka företag du har en roll i enligt offentliga register',
              'Logga in dig med BankID och visa vilka företag du kan företräda',
              'Avtal (art. 6.1 b)',
              'Tills du raderar kontot',
            ],
            [
              'Företagsnamn, organisationsnummer, adress, vilka användare som har vilken roll, e-postadress i inbjudningar',
              'Ge rätt personer åtkomst till rätt företag',
              'Avtal (art. 6.1 b). För den som bjuds in: berättigat intresse (art. 6.1 f) hos den som bjuder in att kunna ge åtkomst',
              'Så länge medlemskapet finns; en inbjudan tills den används eller tas bort',
            ],
            [
              'Faktureringsadress, organisationsnummer, betalningshistorik för abonnemanget',
              'Fakturera och ta betalt för abonnemanget',
              'Avtal (art. 6.1 b) och rättslig förpliktelse (art. 6.1 c, bokföringslagen)',
              'Sju år efter utgången av det kalenderår då vårt räkenskapsår avslutades',
            ],
            [
              `Meddelanden du skickar till supporten i appen eller till ${LEGAL_PROVIDER.email}, med ärendehistorik`,
              'Svara på och följa upp ärenden',
              'Berättigat intresse (art. 6.1 f): kunna hjälpa dig och följa upp',
              'Så länge ärendet behövs för att hjälpa dig och följa upp det',
            ],
            [
              'E-postadress',
              'Meddelanden om säkerhet, driftstörningar och ändrade villkor',
              'Avtal (art. 6.1 b)',
              'Så länge kontot finns',
            ],
            [
              'Räknare per förkortad IP-adress och per användar- eller företags-ID; inloggningshändelser med tidpunkt och IP-adress',
              'Skydda konton och tjänsten mot obehörig åtkomst, överbelastning och missbruk',
              'Berättigat intresse (art. 6.1 f): säkerhet',
              'Räknarna raderas inom en timme; inloggningshändelser så länge de behövs för att upptäcka och utreda säkerhetsincidenter',
            ],
            [
              'Metadata om anrop från API-nycklar och agenter: verktygsnamn, felkod, svarstid, användar-, nyckel- och sessions-ID. Aldrig verktygens indata eller resultat',
              'Hålla API:t och MCP-servern tillförlitliga: felfrekvens per verktyg och kanal',
              'Berättigat intresse (art. 6.1 f): driftsäkerhet',
              '180 dagar',
            ],
            [
              'Tekniska felrapporter från appen och servern, med användar-ID',
              'Hitta och rätta fel',
              'Berättigat intresse (art. 6.1 f): en fungerande tjänst',
              'Så länge felet behöver utredas',
            ],
            [
              'Telefonnummer som du kopplar till WhatsApp-inlämning (lagras krypterat och som hash), chattmeddelanden',
              'Ta emot kvitton du skickar via WhatsApp och fråga om det som saknas',
              'Avtal (art. 6.1 b)',
              'Chattens text 90 dagar; kopplingen tills du tar bort den. Kvittot blir underlag i bokföringen (se biträdesavtalet)',
            ],
            [
              'Om du aktiverar inkasso och utskick: vem som godkände inkasso- och utskicksföretagets villkor och när, och firmatecknarens kontaktuppgifter för signering',
              'Aktivera och signera avtalet med det inkasso- och utskicksföretag du valt (se punkt 10)',
              'Avtal (art. 6.1 b)',
              'Ärendehistorik, rapporterade betalningar och avräkningar hör till fakturan och bevaras lika länge som den, under bokföringslagens lagringstid. Kundens personnummer sparas inte i dem; det finns krypterat på kunden.',
            ],
          ]}
        />
        <p>
          När du raderar ditt konto tar vi direkt bort e-postadress, namn, BankID-uppgifter,
          inloggningssessioner, API-nycklar, inställningar och assistentkonversationer, och
          återkallar de bank-, e-post- och Skatteverketskopplingar du har godkänt. Kvar blir ett
          spärrat konto-ID utan namn eller e-postadress, som bokföringen i företagen pekar på. Du kan
          inte radera kontot medan du är ägare till ett aktivt företag; lämna över eller avsluta
          företaget först.
        </p>
      </LegalSection>

      <LegalSection title="4. Produktanalys och sessionsinspelning">
        <p>
          I appen använder vi PostHog (EU, Frankfurt) för produktanalys, sessionsinspelning och
          korta enkäter. Vi skickar ditt användar-ID, din e-postadress, ditt namn och företagets
          namn, aldrig organisationsnummer. Inspelningarna finns så att vi kan se var i appen du
          stöter på problem, utan att se dina uppgifter.
        </p>
        <p>
          I sessionsinspelningar är maskering standardläget och kan inte stängas av: allt du skriver
          maskeras utan undantag, och all annan text maskeras om den inte är appens eget statiska
          gränssnitt, som rubriker, knappar, menyer och ledtexter. Ditt innehåll (namn,
          beskrivningar, belopp, person- och organisationsnummer) är därför aldrig läsbart, och även
          nytt eller omärkt gränssnitt maskeras tills det uttryckligen märkts som gränssnittstext:
          felläget är övermaskering, aldrig att dina uppgifter syns.
        </p>
        <p>
          Produktanalys, sessionsinspelning och enkäter är påslagna när du är inloggad, och du kan
          när som helst stänga av dem under Inställningar, Konto. Rättslig grund: berättigat
          intresse (art. 6.1 f), vårt intresse av att se var tjänsten krånglar och förbättra den.
          Stänger du av analysen skickas supportärenden du själv skriver med e-post till supporten.
          Analysen använder inga kakor; två små tekniska värden sparas lokalt: vilka enkäter du
          redan sett, och ett slumpmässigt ärende-ID som gör att du hittar tillbaka till ditt
          supportärende i samma webbläsare.
        </p>
        <p>
          Oavsett ditt val skickar vår server felrapporter och några händelser om hur arkivet används
          (till exempel att ett underlag kommit in eller en fråga besvarats, med ditt användar-ID) till
          PostHog. Det sker med stöd av berättigat intresse (art. 6.1 f), vårt intresse av att hålla
          tjänsten fungerande, och läser ingenting från din enhet.
        </p>
      </LegalSection>

      <LegalSection title="5. Kopplade e-postbrevlådor (Gmail)">
        <p>
          Du kan själv koppla en Gmail-brevlåda under Inställningar, Kopplingar och Gmail. Kopplingen
          görs via Googles medgivandeskärm och ger tjänsten enbart läsbehörighet (behörigheten{' '}
          <code>gmail.readonly</code>). Tjänsten kan aldrig skicka, ändra, märka eller radera e-post.
          Ingen brevlåda kopplas utan att dess ägare själv godkänt det.
        </p>
        <p>
          Kopplingen används för en enda funktion, Kvittojakten: när du ber tjänsten leta efter
          underlag söker den i brevlådan efter kvitton och fakturor som hör till köp som redan finns
          i din bokföring men saknar underlag. Sökningen utgår från belopp, datum och motpart för
          varje sådant köp. Rubrik, avsändare och text i de meddelanden som matchar sökningen läses i
          stunden, enbart för att avgöra om meddelandet innehåller kvittot till det köpet. Från
          meddelanden som inte är kvittot sparas ingenting. Endast den bilaga (eller det meddelande)
          som identifierats som kvitto hämtas och läggs i din dokumentinkorg, där du själv granskar
          och godkänner det innan det blir en del av bokföringen. Med ett hämtat underlag sparas
          också varifrån det kom: brevlådans adress, meddelandets avsändare, ämnesrad, datum och
          Gmails meddelande-id. För att avgöra om ett meddelande är ett kvitto och läsa ut beloppet
          används en AI-modell som körs inom EU (se punkt 9).
        </p>
        <p>
          Innehåll från Gmail används aldrig för annonsering, aldrig för att träna AI-modeller och
          säljs eller lämnas aldrig vidare till tredje part. Ingen människa hos oss läser innehållet,
          utom med ditt uttryckliga medgivande i ett supportärende eller när det krävs för säkerhet
          eller enligt lag.
        </p>
        <LegalTable
          head={['Uppgifter', 'Ändamål', 'Rättslig grund', 'Lagringstid']}
          rows={[
            [
              'Brevlådans adress, krypterad åtkomstnyckel (OAuth-token)',
              'Hålla kopplingen aktiv så att sökningar kan göras när du ber om det',
              'Samtycke (art. 6.1 a), lämnat på Googles medgivandeskärm',
              'Tills du kopplar från brevlådan; nycklarna raderas då och åtkomsten återkallas hos Google',
            ],
            [
              'Rubrik, avsändare, datum och text i meddelanden som matchar en sökning',
              'Avgöra om meddelandet är kvittot till ett visst köp',
              'Samtycke (art. 6.1 a)',
              'Behandlas endast i arbetsminnet under sökningen; sparas inte, utom ursprunget för ett hämtat underlag',
            ],
            [
              'Brevlådans adress, avsändare, ämnesrad, datum och meddelande-id för ett hämtat underlag',
              'Visa varifrån underlaget kom, och undvika att samma kvitto hämtas två gånger',
              'Samma som för underlaget',
              'Lika länge som underlaget sparas',
            ],
          ]}
        />
        <p>
          Du kan när som helst koppla från brevlådan i tjänsten, eller återkalla åtkomsten direkt hos
          Google på{' '}
          <a href="https://myaccount.google.com/permissions" className={link}>
            myaccount.google.com/permissions
          </a>
          . Kvitton som redan hämtats ligger kvar i dokumentinkorgen, och de du godkänt som underlag
          ingår i bokföringen.
        </p>
        <p lang="en">
          Accounted&apos;s use and transfer to any other app of information received from Google
          APIs will adhere to the{' '}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className={link}
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </LegalSection>

      <LegalSection title="6. Webbplatsen accounted.se">
        <LegalTable
          head={['Kaka eller verktyg', 'Ändamål', 'Rättslig grund', 'Lagringstid']}
          rows={[
            [
              'acc_cookie_consent',
              'Komma ihåg ditt val om kakor',
              'Nödvändig (undantag från samtyckeskravet)',
              '6 månader',
            ],
            [
              'Google Analytics (_ga, _ga_*), Google Ireland Ltd',
              'Förstå hur webbplatsen används',
              'Samtycke (art. 6.1 a)',
              'Upp till 24 månader',
            ],
            [
              'Vercel Web Analytics',
              'Räkna besök per sida, utan kakor',
              'Samtycke (art. 6.1 a)',
              'Enligt Vercels lagringstid för analysdata',
            ],
            [
              'acc_attrib',
              'Se vilken sida, sökning eller kampanj som ledde till registrering',
              'Samtycke (art. 6.1 a)',
              '90 dagar',
            ],
          ]}
        />
        <p>
          Statistik och attribution startar först när du godkänt dem i kakbannern, och att avböja är
          lika enkelt som att godkänna. Du ändrar eller återkallar ditt val via länken
          &quot;Kakinställningar&quot; i sidfoten; spårningskakorna raderas då. Inbäddat innehåll
          från YouTube, Spotify och Luma laddas först när du klickar på det. Google Analytics
          överför uppgifter till USA under EU-U.S. Data Privacy Framework.
        </p>
      </LegalSection>

      <LegalSection title="7. Kakor och lokal lagring i appen">
        <p>
          Appen använder bara kakor som behövs för att tjänsten ska fungera: inloggningssessionen och
          dess tidsgräns, ditt valda företag, ditt språk och hur du senast loggade in, samt korta
          tillstånd under inbjudningar, BankID-inloggning och e-postbekräftelse. I webbläsarens
          lokala lagring sparas visningsval, som filter, sidstorlek och sidomenyns läge. Under en
          bank- eller betalningssignering ligger personnumret kortvarigt i webbläsarens
          sessionslagring, så att signeringen kan fortsätta efter bankens omdirigering.
        </p>
      </LegalSection>

      <LegalSection title="8. Statistik och gemensam kunskap">
        <p>
          <strong>Anonymiserad statistik.</strong> När du bokför ett AI-förslag sparar vi vilket
          konto som föreslogs, vilket konto som bokfördes, om de stämde överens, och hur säker
          modellen var. Raden innehåller varken företags-ID, belopp eller fritext: den består av
          BAS-kontonummer och ett mått mellan 0 och 1. Den går alltså inte att knyta till er eller
          till någon person, och den lämnas aldrig ut. Vi använder den för att mäta och förbättra den
          automatiska konteringen.
        </p>
        <p>
          <strong>Gemensam motpartskatalog.</strong> När flera företag oberoende av varandra har
          tolkat samma banktext som samma motpart, till exempel en butikskedja, en myndighet eller en
          bank, sparar vi den tolkningen i en gemensam katalog så att alla kunders banktexter tolkas
          bättre. En tolkning tas med först när minst två företag har gjort den, och bara för
          motparter som klassats som handlare, myndigheter, banker eller betalväxlar, aldrig
          privatpersoner. Katalogen innehåller motpartens namn och typ, inte vilka företag tolkningen
          kom från. Ett företags ägare eller administratör kan stänga av företagets medverkan under
          Inställningar, Datadelning och AI; då räknas företagets tolkningar inte in.
        </p>
        <p>
          Själva anonymiseringen och sammanställningen är en behandling, och den sker med stöd av
          berättigat intresse (art. 6.1 f): vårt intresse av att förbättra tolkningen och
          konteringen, vägt mot att inget identifierbart innehåll ingår i resultatet. Statistiken
          används aldrig för marknadsföring, säljs inte, och lämnas inte till någon utanför
          Accounted. Ert eget företags bokföring, med transaktionstexter, motpartsnamn, kvitton och
          fakturor, används inte i utvärderingskörningar eller för att träna modeller, om inte en
          ägare eller administratör har slagit på Bidra med innehåll under Inställningar,
          Datadelning och AI, eller ni har ett skriftligt avtal med oss om just det.
        </p>
      </LegalSection>

      <LegalSection title="9. AI-funktioner">
        <p>
          Tjänsten använder AI för att föreslå kontering av transaktioner, läsa av kvitton och
          fakturor, tolka kvitton i kopplade brevlådor och WhatsApp, och för assistenten i appen. AI:t
          använder Anthropics Claude-modeller men körs inom Amazon Bedrock i EU: datan lämnar inte EU
          och delas inte med Anthropic, och varken Amazon eller Anthropic använder den för att träna
          modeller. Kärntjänsten (bokföring, fakturor, moms och rapporter) fungerar även utan AI.
        </p>
        <p>
          AI-förslag bokförs aldrig av sig själva: ett förslag blir en verifikation först när du,
          eller en agent som du själv har kopplat till tjänsten, godkänner det. Automatisk bokföring
          sker bara enligt regler som du själv har ställt in. Inga beslut med rättslig verkan eller
          annan betydande påverkan för en person fattas automatiskt (art. 22).
        </p>
        <p>
          En ägare eller administratör kan stänga av AI-funktionerna för företaget under
          Inställningar, Datadelning och AI; då skickas inget av företagets innehåll till
          AI-tjänsten. En egen agent som ni kopplat via API eller MCP påverkas inte.
        </p>
        <p>
          <strong>Körjournalens avståndsförslag.</strong> När du klickar på &quot;Föreslå
          sträcka&quot; skickas adresstexterna du angett, via vår server och utan användar-ID, till
          OpenStreetMap Foundation (geokodningstjänsten Nominatim, Storbritannien/EU;
          Storbritannien omfattas av EU:s adekvansbeslut), som översätter dem till koordinater.
          FOSSGIS e.V. (ruttberäkningstjänsten, Tyskland) får därefter endast koordinaterna. Båda är
          självständiga mottagare. Vår server mellanlagrar adresser, koordinater och sträckor i
          arbetsminnet i upp till 24 timmar, utan koppling till ditt konto. En adress, till exempel
          en hemadress, kan i sig vara en personuppgift; skriv platsnamn i stället om du inte vill
          att den skickas.
        </p>
      </LegalSection>

      <LegalSection title="10. Mottagare">
        <p>
          Följande företag behandlar personuppgifter åt oss för det vi är personuppgiftsansvariga
          för. Vilka som behandlar uppgifter i ditt företags bokföring står i{' '}
          <Link href="/subprocessors" className={link}>
            förteckningen över underbiträden
          </Link>
          . Vi säljer aldrig personuppgifter.
        </p>
        <RecipientTable view="privacy" />
        <p>
          <strong>Inkasso- och utskicksföretag som du aktiverar.</strong> Om du aktiverar inkasso
          och utskick lämnar vi uppgifter till det inkasso- och utskicksföretag du har valt, för
          utskick av fakturor med post, till digital brevlåda eller till kundens internetbank och för
          påminnelser och inkasso. Företaget är en mottagare som du själv anlitar, inte vårt
          underbiträde: när du aktiverar kopplingen godkänner du företagets villkor för ditt företags
          räkning, och av dem framgår om företaget behandlar uppgifterna som självständigt
          personuppgiftsansvarig eller som ditt personuppgiftsbiträde. I dag kan du aktivera Kravia
          AB (org.nr 556564-1106) för påminnelser och inkasso; enligt bolagets integritetspolicy är
          Kravia AB personuppgiftsansvarig för den behandling bolaget utför i sin
          inkassoverksamhet. Företagets namn och villkor, och dess information om hur det behandlar
          personuppgifter när sådan finns, visas innan du godkänner.
        </p>
        <p>
          Inget skickas innan en ägare eller administratör har godkänt företagets villkor och
          skickat in ansökan, och sedan bara följande:
        </p>
        <ul>
          <li>
            När ansökan skickas in, villkoren godkänns och avtalet signeras: ditt företags
            uppgifter, kontaktuppgifter, utbetalningskonto och svar på frågor om kundkännedom,
            namnet på den som godkänner villkoren och firmatecknarens e-post om signeringslänken ska
            skickas dit, för en enskild firma även ägarens personnummer.
          </li>
          <li>
            När du skickar en faktura via företaget, lämnar över den till påminnelse eller inkasso,
            ställer in ett återkommande fakturaschema att skicka via företaget eller godkänner en
            sammanställd omgång: fakturan med de betalningar och krediteringar som redan finns på
            den, och uppgifter om kunden (namn, postadress, e-post och telefonnummer när de finns,
            samt organisationsnummer eller, för privatpersoner, personnummer).
          </li>
          <li>
            När du väljer en utskickskanal för en kund: kundens organisationsnummer eller
            personnummer, för att kontrollera att kunden kan nås där.
          </li>
          <li>
            Så länge företaget har ett öppet ärende för en faktura: betalningar och kreditfakturor
            på fakturan, och dina åtgärder i ärendet, till exempel paus, återkallelse eller
            bestridande, med eventuellt meddelande från dig. Om en rapporterad betalning senare tas
            bort eller ändras meddelas det också, även efter att ärendet har avslutats. Ärendets
            status, händelser och avräkningar hämtas tillbaka till tjänsten.
          </li>
        </ul>
        <p>
          Uppgifter om dig själv lämnar vi för att fullgöra tjänsten du har bett om (art. 6.1 b).
          För uppgifter om dina kunder och om andra personer i företaget, som ägare, ledning och
          firmatecknare, är du personuppgiftsansvarig och vi ditt biträde, se{' '}
          <Link href="/dpa" className={link}>
            personuppgiftsbiträdesavtalet
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection title="11. Överföring till tredje land">
        <p>
          Databas och filer lagras i Sverige (Stockholm), och AI-anropen behandlas inom EU. Vissa
          mottagare är amerikanska bolag eller överför uppgifter vidare till USA. För dem gäller
          EU-U.S. Data Privacy Framework när mottagaren är certifierad (Vercel, Resend, Upstash,
          Stripe och Google), och annars EU-kommissionens standardavtalsklausuler (Supabase,
          PostHog och Meta). Vilken skyddsmekanism som gäller för varje mottagare står i tabellen
          ovan. Du kan få en kopia av skyddsåtgärderna genom att kontakta oss.
        </p>
      </LegalSection>

      <LegalSection title="12. Personnummer">
        <p>
          Vi behandlar personnummer endast när det är klart motiverat (3 kap. 10 §
          dataskyddslagen): vid BankID-inloggning, för säker identifiering; för en enskild firma,
          vars organisationsnummer är ägarens personnummer; och när du signerar bank- och
          Skatteverketsärenden. Personnummer för dina anställda och privatkunder behandlar vi som
          biträde åt ditt företag, enligt biträdesavtalet.
        </p>
      </LegalSection>

      <LegalSection title="13. Dina rättigheter">
        <ul>
          <li>
            <strong>Tillgång (art. 15):</strong> du kan få veta vilka uppgifter vi har om dig och få
            en kopia.
          </li>
          <li>
            <strong>Rättelse (art. 16):</strong> du kan få felaktiga uppgifter rättade; de flesta
            kontouppgifter ändrar du själv i appen.
          </li>
          <li>
            <strong>Radering (art. 17):</strong> du kan radera ditt konto i appen eller be oss
            radera uppgifter. Uppgifter som ingår i ett företags räkenskapsinformation bevaras ändå
            under bokföringslagens lagringstid.
          </li>
          <li>
            <strong>Begränsning (art. 18):</strong> du kan begära att vi begränsar behandlingen,
            till exempel medan vi utreder en begäran om rättelse.
          </li>
          <li>
            <strong>Dataportabilitet (art. 20):</strong> du kan exportera bokföringen (SIE4, JSON,
            CSV) i appen, och be oss om dina kontouppgifter i ett maskinläsbart format.
          </li>
          <li>
            <strong>Invändning (art. 21):</strong> du har rätt att när som helst invända mot
            behandling som grundas på berättigat intresse. Vi slutar då, om vi inte kan visa
            tvingande berättigade skäl som väger tyngre.
          </li>
          <li>
            <strong>Återkalla samtycke:</strong> det du har samtyckt till kan du när som helst
            återkalla, utan att det påverkar behandlingen som skett innan.
          </li>
        </ul>
        <p>
          Skriv till {LEGAL_PROVIDER.email}. Vi svarar inom en månad; är begäran omfattande kan
          tiden förlängas med högst två månader, och då meddelar vi dig det.
        </p>
        <p>
          Du har rätt att klaga hos Integritetsskyddsmyndigheten (IMY), Box 8114, 104 20 Stockholm,
          imy@imy.se, www.imy.se.
        </p>
      </LegalSection>

      <LegalSection title="14. Barn och ändringar">
        <p>
          Tjänsten riktar sig till företag och inte till personer under 18 år. Ändras policyn på ett
          sätt som påverkar dig meddelar vi det via e-post innan ändringen börjar gälla. Den senaste
          versionen finns alltid på app.accounted.se/privacy.
        </p>
      </LegalSection>
    </LegalShell>
  )
}
