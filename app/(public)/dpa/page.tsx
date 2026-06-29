import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import Link from 'next/link'
import { getBranding } from '@/lib/branding/service'

export function generateMetadata(): Metadata {
  return {
    title: `Personuppgiftsbiträdesavtal - ${getBranding().appName}`,
  }
}

export default function DPAPage() {
  const { appName, legalEntity, privacyEmail } = getBranding()
  return (
    <div className="min-h-screen bg-background py-12 px-4">
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="text-center space-y-2">
          <h1 className="font-display text-3xl md:text-4xl tracking-tight text-foreground">
            Personuppgiftsbiträdesavtal (DPA)
          </h1>
          <p className="text-sm text-muted-foreground">
            Enligt GDPR Art. 28 &middot; Senast uppdaterad: 2026-06-03
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. Roller</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Detta personuppgiftsbitradesavtal (&quot;DPA&quot;) ingår mellan:
            </p>
            <ul>
              <li><strong>Personuppgiftsansvarig (&quot;den Ansvarige&quot;):</strong> Du som användare av {appName},
                i egenskap av ansvarig för de personuppgifter du registrerar i tjänsten
                (kunder, leverantörer, anställda m.fl.).</li>
              <li><strong>Personuppgiftsbiträde (&quot;Biträdet&quot;):</strong> {legalEntity}, som tillhandahåller
                {' '}{appName}-tjänsten och behandlar personuppgifter på dina vägnar.</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Behandling enligt instruktioner</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Biträdet behandlar personuppgifter endast enligt den Ansvariges dokumenterade
              instruktioner, inklusive vid överföring av personuppgifter till tredjeland eller en
              internationell organisation, om inte unionsrätten eller svensk rätt ålägger Biträdet
              att göra det. I sådant fall informerar Biträdet den Ansvarige om det rättsliga kravet
              innan behandlingen sker, om inte sådan information är förbjuden enligt lag.
            </p>
            <p>
              Om Biträdet anser att en instruktion strider mot GDPR eller andra
              dataskyddsbestämmelser ska Biträdet omedelbart informera den Ansvarige.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">3. Behandlingens syfte och omfattning</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>Biträdet behandlar personuppgifter för följande ändamål:</p>
            <ul>
              <li>Tillhandahållande av bokförings- och redovisningstjänster</li>
              <li>Lagring och arkivering av bokföringsmaterial</li>
              <li>Fakturering och betalningshantering</li>
              <li>Bankkontosynkronisering (PSD2)</li>
              <li>AI-assisterad kategorisering och kvittohantering (efter separat samtycke)</li>
            </ul>
            <p>Kategorier av registrerade vars uppgifter behandlas:</p>
            <ul>
              <li>Den Ansvariges kunder (namn, kontaktuppgifter, organisationsnummer)</li>
              <li>Den Ansvariges leverantörer (namn, kontaktuppgifter, bankuppgifter)</li>
              <li>Den Ansvarige själv (kontouppgifter, företagsinformation)</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">4. Konfidentialitet</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Biträdet säkerställer att de personer som har behörighet att behandla
              personuppgifterna har åtagit sig att iaktta konfidentialitet eller omfattas av en
              lämplig lagstadgad tystnadsplikt. Åtkomst till personuppgifter begränsas till personal
              som behöver uppgifterna för att fullgöra Biträdets åtaganden.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">5. Tekniska och organisatoriska åtgärder</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>Biträdet vidtar följande åtgärder för att skydda personuppgifterna:</p>
            <ul>
              <li><strong>Kryptering:</strong> All data krypteras i transit (TLS 1.3) och i vila (AES-256)</li>
              <li><strong>Åtkomstkontroll:</strong> Row Level Security (RLS) säkerställer att varje användare
                enbart kan komma åt sina egna uppgifter</li>
              <li><strong>Autentisering:</strong> Inloggning med e-post och lösenord (lösenord lagras
                endast som saltad hash, aldrig i klartext), tvåfaktorsautentisering (2FA via TOTP)
                samt BankID (på den hostade tjänsten). Tvåfaktorsautentisering kan krävas för
                åtkomst</li>
              <li><strong>Integritetskontroll:</strong> SHA-256 checksummor för alla dokument, med
                regelbunden verifiering</li>
              <li><strong>Revisionslogg:</strong> Alla ändringshändelser loggas automatiskt av databasen
                (ej redigerbara)</li>
              <li><strong>Oföränderlig bokföring:</strong> Bokförda verifikationer kan inte ändras eller
                raderas (databasutlösare)</li>
              <li><strong>Säkerhetskopior:</strong> Kontinuerliga databaskopior med point-in-time-recovery</li>
              <li><strong>EU-lagring och EU-inferens:</strong> All primär datalagring sker i EU
                (Supabase, eu-north-1, Stockholm). AI-inferens sker, när AI-funktioner är aktiverade, inom
                EU via Amazon Bedrock (eu-north-1, Stockholm) — ingen överföring till tredje land</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">6. Underbiträden</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Biträdet använder underbiträden för att tillhandahålla tjänsten. En fullständig
              förteckning över underbiträden, inklusive syfte och geografisk plats, finns i
              vår{' '}
              <Link href="/privacy" className="text-primary underline underline-offset-4">
                integritetspolicy
              </Link>.
            </p>
            <p>
              Biträdet kommer att informera den Ansvarige minst 30 dagar i förväg innan
              en ny underbiträde anlitas, så att den Ansvarige har möjlighet att invända.
            </p>
            <p>
              Biträdet ålägger genom skriftligt avtal varje underbiträde samma
              dataskyddsskyldigheter som anges i detta avtal. Biträdet förblir fullt ansvarigt
              gentemot den Ansvarige för att underbiträdet fullgör sina skyldigheter.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">7. Bistånd med registrerades rättigheter</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Biträdet bistår den Ansvarige, genom lämpliga tekniska och organisatoriska åtgärder
              och i den mån det är möjligt, med att fullgöra den Ansvariges skyldighet att besvara
              begäran från registrerade om utövande av sina rättigheter enligt GDPR kapitel III
              (art. 12–23), däribland rätt till tillgång, rättelse, radering, begränsning,
              dataportabilitet och invändning.
            </p>
            <p>
              Tjänsten tillhandahåller självbetjäningsfunktioner för export (SIE4, JSON, CSV) och
              radering som stöd för detta.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">8. Dataintrångsnotifiering och bistånd enligt art. 32–36</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Vid en personuppgiftsincident ska Biträdet utan onödigt dröjsmål, och senast
              inom 72 timmar från det att incidenten upptäcktes, meddela den Ansvarige.
              Meddelandet ska innehålla:
            </p>
            <ul>
              <li>Typ av personuppgiftsincident</li>
              <li>Kategorier och ungefärligt antal registrerade som berörts</li>
              <li>Sannolika konsekvenser av incidenten</li>
              <li>Åtgärder som vidtagits eller föreslås för att hantera incidenten</li>
            </ul>
            <p>
              Biträdet bistår den Ansvarige med att säkerställa att skyldigheterna enligt
              art. 32–36 i GDPR fullgörs, med beaktande av behandlingens art och den information
              som Biträdet har tillgång till. Detta omfattar säkerhet i behandlingen (art. 32),
              anmälan av personuppgiftsincidenter (art. 33–34), konsekvensbedömningar avseende
              dataskydd (art. 35, DPIA) samt förhandssamråd med Integritetsskyddsmyndigheten
              (IMY) (art. 36).
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">9. Revisionsrätt</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Den Ansvarige har rätt att, direkt eller genom en oberoende revisor, utföra
              revisioner och inspektioner för att säkerställa att Biträdet uppfyller sina
              åtaganden enligt detta avtal. Biträdet ska tillhandahålla all nödvändig
              information och medverka till revisioner.
            </p>
            <p>
              Revisioner ska ske med rimligt varsel (minst 30 dagar) och under ordinarie
              kontorstider. Biträdet kan erbjuda alternativ i form av tredjepartsgranskningar
              eller certifieringar.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">10. Radering vid avslut</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Vid uppsägning av tjänsten ska Biträdet, enligt den Ansvariges val:
            </p>
            <ul>
              <li>
                <strong>Återlämna:</strong> Exportera alla personuppgifter i maskinläsbart format
                (SIE4, JSON, CSV) via tjänstens exportfunktioner.
              </li>
              <li>
                <strong>Radera:</strong> Radera alla personuppgifter inom 30 dagar från
                användarens begäran, med undantag för uppgifter som måste bevaras enligt lag.
              </li>
            </ul>
            <p>
              <strong>Undantag:</strong> Bokföringsmaterial som omfattas av Bokföringslagen (BFL)
              7 kap. 2 § (7 års arkiveringskrav) raderas först när lagringsfristen löpt ut.
              Under denna period är materialet skyddat mot obehörig åtkomst och ändring.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground text-center">
              Detta personuppgiftsbiträdesavtal träder i kraft när du skapar ett konto på
              {' '}{appName} och gäller så länge du använder tjänsten. För frågor, kontakta oss
              på {privacyEmail}.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
