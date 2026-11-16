import { StandaloneMessage } from '@/components/standalone/StandalonePage'
import type { Metadata } from 'next'
import { SignatoryConnectPage } from '@/components/bank-feed/SignatoryConnectPage'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { openBankFeedDoor } from '@/lib/bank-feed/door'
import { describeInvite, resolveInviteToken } from '@/lib/bank-feed/invites'
import { isEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'

// The token is the authentication: no session, no company context. The
// firmatecknare has no account, so the page is never indexed and the error
// shells speak plain Swedish, as the payslip page does.
export const metadata: Metadata = {
  title: 'Koppla banken',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

function MessageShell({ title, body }: { title: string; body: string }) {
  return <StandaloneMessage title={title} body={body} />
}

export default async function KopplaPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const service = createServiceClientNoCookies()
  const resolved = await resolveInviteToken(service, token)

  // Unknown, expired and consumed read the same: the link no longer opens
  // anything, and whoever sent it can make a new one.
  if (!resolved.ok) {
    return <MessageShell title="Länken är inte längre giltig" body="Länken är inte längre giltig. Be den som skickade länken om en ny." />
  }
  const { invite } = resolved

  // The same door as the session routes: a company the pilot does not admit
  // gets a plain answer, not a flow that fails at the first call.
  const door = await openBankFeedDoor({ supabase: service, companyId: invite.company_id })
  if (!door.ok) {
    return (
      <MessageShell
        title="Bankkoppling med BankID är inte påslagen"
        body="Företaget är inte påslaget för bankkoppling via Open Payments ännu. Be den som skickade länken att kontakta Accounted."
      />
    )
  }

  const [description, companyRow] = await Promise.all([
    describeInvite(service, invite),
    service.from('companies').select('entity_type').eq('id', invite.company_id).maybeSingle(),
  ])
  const entityType = (companyRow.data as { entity_type?: string | null } | null)?.entity_type
  const soleTrader = isEntityType(entityType) && usesPersonnummerAsOrgNumber(entityType)
  const replaced = description.replaced

  return (
    <SignatoryConnectPage
      token={token}
      companyName={description.companyName}
      requester={description.requester}
      soleTrader={soleTrader}
      mode={replaced ? replaced.kind : 'new'}
      bic={invite.bic ?? replaced?.bic ?? null}
      replace={replaced ? { connectionId: replaced.connection_id, bankName: replaced.bank_name } : null}
      offerPayments={invite.offer_payments}
    />
  )
}
