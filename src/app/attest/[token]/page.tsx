import type { Metadata } from 'next'
import { AttestLinkPage } from '@/components/supplier-invoices/AttestLinkPage'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { resolveAttestLink } from '@/lib/supplier-invoices/attest-links'
import { describeAttestLink } from '@/lib/supplier-invoices/attest-link-route'
import { loadActiveAttestMembers } from '@/lib/supplier-invoices/attest-service'

// The token is the authentication: no session, no company context. The page
// is never indexed and the error shell speaks plain Swedish, as the signing
// page under /betala does.
export const metadata: Metadata = {
  title: 'Attestera leverantörsfaktura',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

function MessageShell({ title, body }: { title: string; body: string }) {
  return (
    <main className="min-h-dvh bg-background flex items-center justify-center px-4 md:px-6">
      <div className="max-w-md w-full rounded-lg border border-border p-6 space-y-2">
        <h1 className="font-display text-2xl tracking-tight">{title}</h1>
        <p className="text-[13px] text-muted-foreground">{body}</p>
      </div>
    </main>
  )
}

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
  const gone = <MessageShell title="Länken är inte längre giltig" body="Länken har redan använts eller gått ut. Logga in för att attestera fakturan." />
  if (!resolved?.ok) return gone
  const members = await loadActiveAttestMembers(service, resolved.link.company_id)
  if (!members.has(resolved.link.attester_user_id)) return gone

  const data = await describeAttestLink(service, resolved.link, log)
  const preselected = beslut === 'neka' ? 'reject' : beslut === 'godkann' ? 'approve' : null
  return <AttestLinkPage token={token} initial={data} preselected={preselected} />
}
