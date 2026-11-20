import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalSection, LegalShell } from '@/components/legal/LegalShell'
import { RecipientTable } from '@/components/legal/RecipientTable'
import { LEGAL_DOCUMENTS, LEGAL_PROVIDER } from '@/lib/legal/documents'

export function generateMetadata(): Metadata {
  return { title: 'Underbiträden - Accounted' }
}

export default function SubprocessorsPage() {
  return (
    <LegalShell
      title="Underbiträden"
      subtitle="Bilaga till personuppgiftsbiträdesavtalet, punkt 6"
      updatedAt={LEGAL_DOCUMENTS.subprocessors.updatedAt}
    >
      <LegalSection title="Förteckning">
        <p>
          Här är de företag som {LEGAL_PROVIDER.name} anlitar för att behandla personuppgifter i
          ditt företags bokföring för din räkning. Förteckningen är en del av{' '}
          <Link href="/dpa" className="text-primary underline underline-offset-4">
            personuppgiftsbiträdesavtalet
          </Link>
          . Vi meddelar dig via e-post minst 30 dagar innan ett underbiträde läggs till eller byts
          ut, och du har rätt att invända enligt avtalets punkt 6.
        </p>
        <RecipientTable view="dpa" />
      </LegalSection>

      <LegalSection title="Det här är inte underbiträden">
        <ul>
          <li>
            <strong>Mottagare som du själv väljer.</strong> När du skickar en deklaration till
            Skatteverket, en årsredovisning till Bolagsverket, kopplar din egen Google- eller
            Dropbox-lagring för säkerhetskopior, söker kvitton i din egen Gmail, eller hämtar data
            från Stripe, Shopify, WooCommerce, Zettle eller ett tidigare bokföringsprogram, lämnas
            eller hämtas uppgifter på din instruktion. Mottagaren behandlar då uppgifterna enligt
            sina egna villkor med dig.
          </li>
          <li>
            <strong>Din egen AI-agent.</strong> Kopplar du en egen agent (till exempel Claude) till
            tjänsten med en API-nyckel eller via MCP, är agenten och dess leverantör något du har
            valt. Det som agenten läser och gör sker på din instruktion.
          </li>
          <li>
            <strong>Accounted Connect</strong> är vår egen tjänst för bank-, Skatteverket- och
            Peppolkopplingar. Den drivs av {LEGAL_PROVIDER.name} hos Vercel och Supabase i
            Stockholm, som finns i förteckningen ovan.
          </li>
        </ul>
        <p>
          Vilka företag vi själva anlitar för uppgifter som vi är personuppgiftsansvariga för,
          till exempel produktanalys och betalning av abonnemang, står i{' '}
          <Link href="/privacy" className="text-primary underline underline-offset-4">
            integritetspolicyn
          </Link>
          .
        </p>
      </LegalSection>
    </LegalShell>
  )
}
