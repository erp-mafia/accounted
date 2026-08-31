import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { BellRing, ListChecks, Mail, PlugZap, Send, Wand2 } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { getByraMembership } from '@/lib/clients/fetch-client-overview'
import { getDashboardAuthContext } from '../../request-context'

export const dynamic = 'force-dynamic'

/**
 * Byrå cockpit: Automationer. Nothing is buildable yet; instead of a bare
 * empty state the page shows the planned automation set (the byrå-tools
 * research shortlist) so the surface sells the roadmap. All static: no
 * per-card chips (same state on every card = no chip, design rule 5), one
 * intro line carries the "coming" message.
 */

const CARDS = [
  { key: 'digest', icon: Mail },
  { key: 'deadlines', icon: BellRing },
  { key: 'rules', icon: Wand2 },
  { key: 'connections', icon: PlugZap },
  { key: 'checklist', icon: ListChecks },
  { key: 'reports', icon: Send },
] as const

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
      <p className="max-w-2xl text-sm text-muted-foreground">{t('automations_intro')}</p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 stagger-enter">
        {CARDS.map(({ key, icon: Icon }) => (
          <div key={key} className="rounded-lg border border-border p-6">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <h2 className="mt-3 text-sm font-medium">{t(`automations_card_${key}_title`)}</h2>
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
              {t(`automations_card_${key}_desc`)}
            </p>
          </div>
        ))}
      </div>

      <p className="text-[13px] text-muted-foreground">{t('automations_footer')}</p>
    </div>
  )
}
