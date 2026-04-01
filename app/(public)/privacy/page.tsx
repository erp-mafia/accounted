import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata: Metadata = {
  title: 'Integritetspolicy - Gnubok',
}

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white py-12 px-4">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Integritetspolicy
          </h1>
          <p className="text-muted-foreground">
            Senast uppdaterad: 2026-03-05
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>1. Personuppgiftsansvarig</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Arcim (&quot;vi&quot;, &quot;oss&quot;) är personuppgiftsansvarig för behandlingen av dina
              personuppgifter i samband med användningen av Gnubok. Vi behandlar dina uppgifter i
              enlighet med EU:s dataskyddsförordning (GDPR) och svensk dataskyddslagstiftning.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Vilka uppgifter vi behandlar</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>Vi behandlar följande kategorier av personuppgifter:</p>
            <ul>
              <li><strong>Kontouppgifter:</strong> E-postadress (för inloggning via magic link)</li>
              <li><strong>Företagsuppgifter:</strong> Företagsnamn, organisationsnummer, adress, kontaktuppgifter</li>
              <li><strong>Bokföringsdata:</strong> Verifikationer, fakturor, kvitton, transaktioner, kontoplaner</li>
              <li><strong>Bankdata:</strong> Kontosaldon och transaktioner (via PSD2-koppling)</li>
              <li><strong>Dokument:</strong> Uppladdade kvitton, fakturor och andra bokföringsunderlag</li>
              <li><strong>Tekniska uppgifter:</strong> IP-adress, enhetstyp, användningsstatistik</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3. Rättslig grund (GDPR Art. 6)</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
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
                bedrägeriforbud.
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
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Vi använder följande underbiträden för att tillhandahålla tjänsten. Uppgifterna nedan anger
              vilka uppgifter som delas med respektive underbiträde, syftet samt var behandlingen sker
              (GDPR Art. 13).
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
                    <td className="py-2 pr-4">EU (eu-central-1)</td>
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
                    <td className="py-2 pr-4 font-medium">Resend</td>
                    <td className="py-2 pr-4">Transaktionell e-postleverans</td>
                    <td className="py-2 pr-4">USA</td>
                    <td className="py-2">SCCs (standardavtalsklausuler)</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4 font-medium">Recapt</td>
                    <td className="py-2 pr-4">Produktanalys och användarfeedback</td>
                    <td className="py-2 pr-4">EU</td>
                    <td className="py-2">EU-baserad</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-sm text-muted-foreground">
              AI-funktioner (Anthropic, OpenAI) kräver separat samtycke före aktivering.
              Data skickas först när du aktivt godkänner användningen.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>5. Tredjelandsöverföring</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Vissa underbiträden är baserade i USA. För dessa överföringar används EU-kommissionens
              standardavtalsklausuler (SCCs) som skyddsmekanism i enlighet med GDPR kapitel V.
              All primär datalagring (databas, filer) sker inom EU via Supabase (eu-central-1).
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>6. Lagringstid</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <ul>
              <li>
                <strong>Bokföringsmaterial:</strong> 7 år från räkenskapsårets slut, i enlighet
                med Bokföringslagen (BFL) 7 kap. 2 §. Systemet hindrar radering av material
                kopplat till bokförda verifikationer under denna period.
              </li>
              <li>
                <strong>Kontouppgifter:</strong> Så länge kontot är aktivt, plus 30 dagar efter
                begäran om radering (för att hantera pågående bokföringsplikter).
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
          <CardContent className="prose prose-sm max-w-none">
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
          <CardContent className="prose prose-sm max-w-none">
            <p>
              För frågor om behandlingen av dina personuppgifter, kontakta oss:
            </p>
            <ul>
              <li><strong>Företag:</strong> Arcim</li>
              <li><strong>E-post:</strong> privacy@gnubok.se</li>
            </ul>
            <p>
              Du har även rätt att lämna klagomål till Integritetsskyddsmyndigheten (IMY),
              www.imy.se.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
