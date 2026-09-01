import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyByraClients } from '@/components/ui/empty-state'
import { fetchByraKpiOverview } from '@/lib/byra/kpi-overview'
import ByraKpiView from '@/components/byra/ByraKpiView'
import { getDashboardAuthContext } from '../../request-context'

export const dynamic = 'force-dynamic'

/**
 * Byrå cockpit: Nyckeltal (WL-16). Aggregated cross-client KPI view: period
 * preset + company chips in the URL (shareable, server-refetched), summary
 * tiles, merged monthly chart, and a sortable per-client table. Byrå team
 * members only, like the rest of the cockpit.
 */
export default async function ByraKpiPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { supabase, user } = await getDashboardAuthContext()
  if (!user) {
    redirect('/login')
  }

  const params = await searchParams
  const period = typeof params.period === 'string' ? params.period : undefined
  const companiesParam = typeof params.companies === 'string' ? params.companies : undefined
  const companyIds = companiesParam
    ? companiesParam.split(',').filter((id) => id.length > 0)
    : undefined

  const overview = await fetchByraKpiOverview(supabase, user.id, {
    preset: period,
    companyIds,
  })
  if (!overview) {
    redirect('/')
  }

  const t = await getTranslations('byra')

  return (
    <div className="space-y-8">
      <PageHeader title={t('kpi_title')} />
      {overview.allClients.length === 0 ? (
        <EmptyByraClients />
      ) : (
        <ByraKpiView
          preset={overview.preset}
          allClients={overview.allClients}
          selectedIds={overview.selectedIds}
          rows={overview.rows}
          months={overview.months}
        />
      )}
    </div>
  )
}
