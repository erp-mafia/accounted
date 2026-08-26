import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SourceCodeFooter } from '@/components/branding/SourceCodeFooter'
import { getBranding } from '@/lib/branding/service'

export function generateMetadata(): Metadata {
  return {
    title: `Integritetspolicy - ${getBranding().appName}`,
  }
}

export default function PrivacyPolicyPage() {
  const { appName, legalEntity, privacyEmail } = getBranding()
  return (
    <div className="min-h-dvh bg-background py-12 px-4">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="text-center mb-8">
          <h1 className="text-3xl text-foreground mb-2">
            Integritetspolicy
          </h1>
          <p className="text-muted-foreground">
            Senast uppdaterad: 2026-08-21
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>1. Personuppgiftsansvarig</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm dark:prose-invert max-w-none">
            <p>
              {legalEntity} (&quot;vi&quot;, &quot;oss&quot;) är personuppgiftsansvarig för behandlingen av dina
              personuppgifter i samband med användningen av {appName}. Vi behandlar dina uppgifter i
              enlighet med EU:s dataskyddsförordning (GDPR) och svensk dataskyddslagstiftning.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Vilka uppgifter vi behandlar</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm dark:prose-invert max-w-none">
            <p>Vi behandlar följande kategorier av personuppgifter:</p>
            <ul>
              <li><strong>Kontouppgifter:</strong> E-postadress (för inloggning)</li>
              <li><strong>Företagsuppgifter:</strong> Företagsnamn, organisationsnummer, adress, kontaktuppgifter</li>
              <li><strong>Kundidentitet:</strong> Personnummer för privatkunder när det behövs för avtal eller fakturering</li>
              <li><strong>Bokföringsdata:</strong> Verifikationer, fakturor, kvitton, transaktioner, kontoplaner</li>
              <li><strong>Bankdata:</strong> Kontosaldon och transaktioner (via PSD2-koppling)</li>
              <li><strong>Dokument:</strong> Uppladdade kvitton, fakturor och andra bokföringsunderlag</li>
              <li><strong>Fakturaleverans:</strong> Mottagaradress, leveransstatus, tidpunkt och innehållet i skickade fakturamejl</li>
              <li><strong>Tekniska uppgifter:</strong> IP-adress, enhetstyp, användningsstatistik</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3. Rättslig grund (GDPR Art. 6)</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm dark:prose-invert max-w-none">
            <ul>
              <li>
                <strong>Avtal (Art. 6.1b):</strong> Behandling som är nödvändig för att fullgöra våra
                tjänster enligt användaravtalet.
              </li>
              <li>
                <strong>Rättslig förpliktelse (Art. 6.1c):</strong> Bokföringslagens (BFL) krav på
                7 års arkivering av räkenskapsmaterial.
              </li>
              <li>
                <strong>Berättigat intresse (Art. 6.1f):</strong> Produktförbättringar, säkerhet och
                bedrägeribekämpning.
              </li>
              <li>
                <strong>Samtycke (Art. 6.1a):</strong> För AI-baserade funktioner som skickar data
                till tredjepartstjänster (se separat samtycke vid aktivering).
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>4. Underbiträden</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm dark:prose-invert max-w-none">
            <p>
              Vi använder följande underbiträden för att tillhandahålla tjänsten. Uppgifterna nedan anger
              vilka uppgifter som delas med respektive underbiträde, syftet samt var behandlingen sker
              (GDPR Art. 13).
            </p>
            <p>
              Behandlar du själv personuppgifter åt andra (kunder, leverantörer, anställda)? Se vårt
              fullständiga{' '}
              <Link href="/dpa" className="text-primary underline underline-offset-4">
                personuppgiftsbiträdesavtal (DPA)
              </Link>{' '}
              enligt GDPR Art. 28.
            </p>

            <div className="overflow-x-auto mt-4">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-4 font-semibold">Underbiträde</th>
                    <th className="text-left py-2 pr-4 font-semibold">Syfte</th>
                    <th className="text-left py-2 pr-4 font-semibold">Plats</th>
                    <th className="text-left py-2 font-semibold">Skyddsmekanism</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b">
                    <td className="py-2 pr-4 font-medium">Supabase</td>
                    <td className="py-2 pr-4">Databas, autentisering, fillagring</td>
                    <td className="py-2 pr-4">EU (eu-north-1, Stockholm)</td>
                    <td className="py-2">EU-baserad lagring</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4 font-medium">Vercel</td>
                    <td className="py-2 pr-4">Applikationshosting</td>
                    <td className="py-2 pr-4">Globalt CDN (EU-regioner tillgängliga)</td>
                    <td className="py-2">EU Data Residency</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4 font-medium">Enable Banking</td>
                    <td className="py-2 pr-4">PSD2-bankkontouppkoppling</td>
                    <td className="py-2 pr-4">EU</td>
                    <td className="py-2">EU-baserad</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4 font-medium">Amazon Web Services (AWS)</td>
                    <td className="py-2 pr-4">
                      AI-inferens (kategorisering samt dokument- och
                      kvittotolkning): AI-anropen skickas till Amazon Bedrock,
                      och modellerna som används är Anthropics Claude-modeller,
                      körda inom Bedrock. Bearbetar bokföringsdata och
                      uppladdade underlag: endast när AI-funktioner är
                      aktiverade.
                    </td>
                    <td className="py-2 pr-4">EU (eu-north-1, Stockholm)</td>
                    <td className="py-2">
                      EU-baserad inferens: ingen tredjelandsöverföring. DPA, SCC
                      och DPF-certifiering. Prompter lagras ej efter anropet och
                      används ej till modellträning.
                    </td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4 font-medium">Resend</td>
                    <td className="py-2 pr-4">Transaktionell e-postleverans</td>
                    <td className="py-2 pr-4">USA</td>
                    <td className="py-2">SCCs (standardavtalsklausuler)</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4 font-medium">PostHog</td>
                    <td className="py-2 pr-4">
                      Produktanalys, sessionsinspelning, felrapportering,
                      enkäter och supportärenden. Överförda uppgifter:
                      användar-ID, e-postadress, namn och företagsnamn. Om du
                      själv skriver till supporten i appen skickas även ditt
                      meddelande dit som ett ärende, så att vi kan svara. I
                      sessionsinspelningar är maskering standardläget och kan
                      inte stängas av: allt du skriver maskeras utan undantag,
                      och all annan text maskeras om den inte är appens eget
                      statiska gränssnitt, som rubriker, knappar, menyer och
                      ledtexter. Ditt innehåll (namn, beskrivningar, belopp,
                      person- och organisationsnummer) är därför aldrig
                      läsbart, och även nytt eller omärkt gränssnitt maskeras
                      tills det uttryckligen märkts som gränssnittstext:
                      felläget är övermaskering, aldrig att dina uppgifter
                      syns. Inspelningarna finns så att vi kan se var i appen
                      du stöter på problem utan att se dina uppgifter.
                      Organisationsnummer skickas aldrig som analysdata.
                      Identifiering sker endast för inloggade användare (ej
                      sandbox/demo). Inga kakor används, och själva analysdatan
                      lagras inte på din enhet. Två små tekniska värden sparas
                      dock lokalt: en markering om vilka enkäter du redan sett,
                      så att du inte får samma fråga igen, och ett
                      slumpmässigt ärende-ID som gör att du hittar tillbaka
                      till ditt supportärende i samma webbläsare. Inget av dem
                      innehåller personuppgifter.
                    </td>
                    <td className="py-2 pr-4">EU (Frankfurt)</td>
                    <td className="py-2">
                      EU-baserad: ingen tredjelandsöverföring. DPA, SCCs vid
                      eventuella underbiträden utanför EES.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="mt-4">
              Utöver underbiträdena ovan använder körjournalens avståndsförslag
              två självständiga mottagare som vi inte har biträdesavtal med.
              Uppgifterna skickas bara när du själv klickar på
              &quot;Föreslå sträcka&quot; i körjournalen, via vår server och
              utan användar-ID eller andra kontouppgifter, och varje mottagare
              får olika uppgifter: OpenStreetMap Foundation (geokodningstjänsten
              Nominatim, Storbritannien/EU; Storbritannien omfattas av EU:s
              adekvansbeslut) tar emot adresstexterna du angett och översätter
              dem till kartkoordinater, och FOSSGIS e.V.
              (ruttberäkningstjänsten, Tyskland) tar därefter emot endast
              koordinaterna, aldrig adresstexterna. För att minska antalet
              anrop mellanlagrar vår server adresstexter, koordinater och
              beräknade sträckor i arbetsminnet i upp till 24 timmar; de
              skrivs inte till databasen och kopplas inte till ditt konto.
              Tänk på att en adress du anger, till exempel en hemadress, i sig
              kan vara en personuppgift; skriv platsnamn i stället för exakta
              adresser om du inte vill att de skickas.
            </p>

            <p className="mt-4 text-sm text-muted-foreground">
              AI-funktioner är frivilliga och kräver separat samtycke före
              aktivering: data skickas först när du aktivt godkänner
              användningen. AI:t använder Anthropics Claude-modeller men körs
              inom Amazon Bedrock i EU (eu-north-1, Stockholm); datan lämnar
              alltså inte EU och delas inte med Anthropic. Kärntjänsten
              (bokföring, fakturor, moms och rapporter) fungerar fullt ut utan AI.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>5. Tredjelandsöverföring</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm dark:prose-invert max-w-none">
            <p>
              Vissa underbiträden är baserade i USA. För dessa överföringar används EU-kommissionens
              standardavtalsklausuler (SCCs) som skyddsmekanism i enlighet med GDPR kapitel V.
              All primär datalagring (databas, filer) sker inom EU via Supabase (eu-north-1, Stockholm).
              Även AI-inferens sker inom EU (Amazon Bedrock, eu-north-1) och innebär ingen
              överföring till tredje land.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>6. Lagringstid</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm dark:prose-invert max-w-none">
            <ul>
              <li>
                <strong>Bokföringsmaterial:</strong> 7 år från räkenskapsårets slut, i enlighet
                med Bokföringslagen (BFL) 7 kap. 2 §. Systemet hindrar radering av material
                kopplat till bokförda verifikationer under denna period.
              </li>
              <li>
                <strong>Fakturaleverans:</strong> Leveransbevis och den skickade PDF-filen bevaras
                under bokföringslagens lagringstid. Därefter raderas mottagaradresser,
                meddelandeinnehåll och andra personuppgifter automatiskt från leveranshistoriken.
              </li>
              <li>
                <strong>Kontouppgifter:</strong> Så länge kontot är aktivt, plus 30 dagar efter
                begäran om radering (för att hantera pågående bokföringsplikter).
              </li>
              <li>
                <strong>Kundidentitet:</strong> Under kundrelationen, eller i sju år när uppgiften
                ingår i räkenskapsinformation som måste bevaras.
              </li>
              <li>
                <strong>Tekniska loggar:</strong> Maximalt 90 dagar.
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>7. Dina rättigheter</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm dark:prose-invert max-w-none">
            <p>Du har följande rättigheter enligt GDPR:</p>
            <ul>
              <li><strong>Tillgång (Art. 15):</strong> Du kan begära en kopia av alla dina personuppgifter.</li>
              <li><strong>Rättelse (Art. 16):</strong> Du kan begära rättelse av felaktiga uppgifter.</li>
              <li><strong>Radering (Art. 17):</strong> Du kan begära radering, med undantag för uppgifter som
                omfattas av lagstadgade arkiveringskrav (BFL 7 år).</li>
              <li><strong>Begränsning (Art. 18):</strong> Du kan begära begränsning av behandlingen.</li>
              <li><strong>Dataportabilitet (Art. 20):</strong> Du kan exportera dina uppgifter i
                maskinläsbart format (SIE4, JSON, CSV) via exportfunktionerna i appen.</li>
              <li><strong>Invändning (Art. 21):</strong> Du kan invända mot behandling baserad på
                berättigat intresse.</li>
            </ul>
            <p>
              För att utöva dina rättigheter, kontakta oss på adressen nedan. Vi besvarar alla
              förfrågningar inom 30 dagar.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>8. Kontaktuppgifter</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm dark:prose-invert max-w-none">
            <p>
              För frågor om behandlingen av dina personuppgifter, kontakta oss:
            </p>
            <ul>
              <li><strong>Företag:</strong> {legalEntity}</li>
              <li><strong>E-post:</strong> {privacyEmail}</li>
            </ul>
            <p>
              Du har även rätt att lämna klagomål till Integritetsskyddsmyndigheten (IMY),
              www.imy.se.
            </p>
          </CardContent>
        </Card>

        {/* AGPL section 13 source offer (WL-06): renders on both default and
            branded hosts; never gate this on a brand. */}
        <SourceCodeFooter className="pt-2" />
      </div>
    </div>
  )
}
