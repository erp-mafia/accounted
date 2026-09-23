import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { getByraMembership } from '@/lib/clients/fetch-client-overview'
import { getDashboardAuthContext } from '../../request-context'
import SignupAccessManager from './SignupAccessManager'

export const dynamic = 'force-dynamic'

/**
 * Byrå cockpit: invite-only signup management for the team's brand domain
 * (2026-08-27). Any byrå team member may look; owner/admin may change the
 * mode and the allowlist (the API and RLS both enforce that). Non-byrå
 * users are redirected like the rest of the cockpit.
 */
export default async function SignupAccessPage() {
  const { supabase, user } = await getDashboardAuthContext()
  if (!user) {
    redirect('/login')
  }

  const membership = await getByraMembership(supabase, user.id)
  if (!membership) {
    redirect('/')
  }

  const t = await getTranslations('clients')

  return (
    <div className="space-y-8">
      <PageHeader title={t('access_title')} />
      <SignupAccessManager
        canEdit={membership.role === 'owner' || membership.role === 'admin'}
      />
    </div>
  )
}
