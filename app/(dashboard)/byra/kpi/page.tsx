import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { TrendingUp } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { getByraMembership } from '@/lib/clients/fetch-client-overview'
import { getDashboardAuthContext } from '../../request-context'

export const dynamic = 'force-dynamic'

/**
 * Byrå cockpit: Nyckeltal. Placeholder for the aggregated cross-client KPI
 * view (all client companies, filterable); only the surface exists for now
 * so the lean cockpit sidebar has its final shape.
 */
export default async function ByraKpiPage() {
  const { supabase, user } = await getDashboardAuthContext()
  if (!user) {
    redirect('/login')
  }

  const membership = await getByraMembership(supabase, user.id)
  if (!membership) {
    redirect('/')
  }

  const t = await getTranslations('byra')

  return (
    <div className="space-y-8">
      <PageHeader title={t('kpi_title')} />
      <EmptyState
        icon={TrendingUp}
        title={t('kpi_empty_title')}
        description={t('kpi_empty_description')}
      />
    </div>
  )
}
