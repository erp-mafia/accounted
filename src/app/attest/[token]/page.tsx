import type { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { StandaloneMessage } from '@/components/standalone/StandalonePage'
import { AttestLinkPage } from '@/components/supplier-invoices/AttestLinkPage'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { resolveAttestLink } from '@/lib/supplier-invoices/attest-links'
import { attesterCanStillDecide, describeAttestLink } from '@/lib/supplier-invoices/attest-link-route'

// The token is the authentication: no session, no company context. The page
// is never indexed and the error shell speaks plain Swedish, as the signing
// page under /betala does.
export const metadata: Metadata = {
  title: 'Attestera leverantörsfaktura',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

export default async function AttestPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ beslut?: string }>
}) {
  const { token } = await params
  const { beslut } = await searchParams
  const service = createServiceClientNoCookies()
  const log = createLogger('attest-link-page')
  const resolved = await resolveAttestLink(service, token).catch(() => null)

  // Unknown, expired and used read the same: the link no longer opens
  // anything, and the invoice can still be attested in Accounted.
  const gone = (
    <StandaloneMessage title="Länken är inte längre giltig" body="Länken har redan använts eller gått ut. Logga in för att attestera fakturan.">
      <Button asChild size="lg" variant="outline">
        <Link href="/login">Logga in</Link>
      </Button>
    </StandaloneMessage>
  )
  if (!resolved?.ok) return gone
  if (!(await attesterCanStillDecide(service, resolved.link))) return gone

  const data = await describeAttestLink(service, resolved.link, log)
  const preselected = beslut === 'neka' ? 'reject' : beslut === 'godkann' ? 'approve' : null
  return <AttestLinkPage token={token} initial={data} preselected={preselected} />
}
