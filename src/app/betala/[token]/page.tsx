import { StandaloneMessage } from '@/components/standalone/StandalonePage'
import type { Metadata } from 'next'
import { PaymentSigningLinkPage } from '@/components/payments/PaymentSigningLinkPage'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { CONSUMED_SIGNING_LINK_GRACE_MS, describePaymentSigningLink, resolvePaymentSigningLink } from '@/lib/payments/orders/signing-links'
import { openPaymentsDoor } from '@/lib/payments/orders/switched-on'

// The token is the authentication: no session, no company context. The
// firmatecknare has no account, so the page is never indexed and the error
// shells speak plain Swedish, as the signatory page under /koppla does.
export const metadata: Metadata = {
  title: 'Signera betalningar',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

function MessageShell({ title, body }: { title: string; body: string }) {
  return <StandaloneMessage title={title} body={body} />
}

export default async function BetalaPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const service = createServiceClientNoCookies()
  // A link its signing consumed still opens for a short while, on the done screen.
  const resolved = await resolvePaymentSigningLink(service, token, { allowConsumedWithinMs: CONSUMED_SIGNING_LINK_GRACE_MS })

  // Unknown, expired, cancelled and long consumed read the same: the link no
  // longer opens anything, and whoever sent it can make a new one.
  if (!resolved.ok) {
    return <MessageShell title="Länken är inte längre giltig" body="Länken är inte längre giltig. Be den som skickade länken om en ny." />
  }
  const { link } = resolved

  // The same door as the session routes: a company that may not pay through
  // the bank right now gets a plain answer, not a flow that fails at the first call.
  const door = await openPaymentsDoor({ supabase: service, companyId: link.company_id })
  if (!door.ok && !link.consumed_at) {
    return (
      <MessageShell
        title="Betalningar via banken är inte påslagna"
        body="Företaget kan inte betala via banken från Accounted just nu. Be den som skickade länken att kontakta Accounted."
      />
    )
  }

  return <PaymentSigningLinkPage token={token} initial={await describePaymentSigningLink(service, link)} />
}
