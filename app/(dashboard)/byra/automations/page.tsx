import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Workflow } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { getByraMembership } from '@/lib/clients/fetch-client-overview'
import { getDashboardAuthContext } from '../../request-context'

export const dynamic = 'force-dynamic'

/**
 * Byrå cockpit: Automationer. Deliberately empty for now: the entry exists
 * so the lean cockpit sidebar has its final shape; the automation flows for
 * client companies land here later.
 */
export default async function ByraAutomationsPage() {
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
      <PageHeader title={t('automations_title')} />
      <EmptyState
        icon={Workflow}
        title={t('automations_empty_title')}
        description={t('automations_empty_description')}
      />
    </div>
  )
}
