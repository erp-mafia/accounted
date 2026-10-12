import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { switchCampaign, switchDaysLeft } from '@/lib/bank-feed/switch-campaign'
import { fetchClientOverview } from '@/lib/clients/fetch-client-overview'
import { getDashboardAuthContext } from '../request-context'
import ClientsTable from './ClientsTable'
import NewClientCompanyButton from './NewClientCompanyButton'

export const dynamic = 'force-dynamic'

/**
 * Byrå cockpit: the client list (WL-14). Five urgency-sorted columns per
 * client company; byrå team members only: everyone else is redirected to the
 * dashboard (the API mirrors this with 403). Read-first (WL-09): this page
 * only aggregates; acting on a client happens by jumping in, which switches
 * the active company.
 */
export default async function ClientsPage() {
  const { supabase, user } = await getDashboardAuthContext()
  if (!user) {
    redirect('/login')
  }

  const overview = await fetchClientOverview(supabase, user.id)
  if (!overview) {
    // Not a byrå team member: the cockpit is byrå-exclusive in v1.
    redirect('/')
  }

  const t = await getTranslations('clients')
  const canCreate = overview.role === 'owner' || overview.role === 'admin'
  // The bank connection switch campaign: the column and the nudges show
  // while it is on. The route behind the nudge checks the caller's write role
  // in each client company.
  const campaign = switchCampaign()
  const bankSwitchCampaign = campaign.on ? { deadline: campaign.deadline, passed: switchDaysLeft(campaign.deadline) < 0 } : null

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" className="text-muted-foreground" asChild>
              <Link href="/clients/access">{t('access_link')}</Link>
            </Button>
            {canCreate && <NewClientCompanyButton />}
          </div>
        }
      />
      <ClientsTable clients={overview.clients} bankSwitchCampaign={bankSwitchCampaign} />
    </div>
  )
}
