import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { LIST_BLEED_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table-classes'
import { getByraMembership } from '@/lib/clients/fetch-client-overview'
import { getDashboardAuthContext } from '../../request-context'

export const dynamic = 'force-dynamic'

/**
 * Byrå cockpit: Automationer. Nothing is buildable yet; instead of a bare
 * empty state the page lists the planned automation set (the byrå-tools
 * research shortlist) so the surface sells the roadmap. Flat rows straight on
 * the panel, as every list: what each one does, and its state as muted text
 * (the same state on every row is never a chip, design rule 5).
 */

const AUTOMATIONS = ['digest', 'deadlines', 'rules', 'connections', 'checklist', 'reports'] as const

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

      {/* The class constants come from a client module: on the server they are references, passed whole and never composed. */}
      <div className={LIST_BLEED_CLASS}>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={TH_CLASS}>{t('automations_col_name')}</th>
              <th className={TH_CLASS}>{t('automations_col_what')}</th>
              <th className={TH_CLASS}>{t('automations_col_status')}</th>
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {AUTOMATIONS.map((key) => (
              <tr key={key}>
                <td className={TD_CLASS}>
                  <span className="font-medium text-foreground">{t(`automations_card_${key}_title`)}</span>
                </td>
                <td className={TD_CLASS}>{t(`automations_card_${key}_desc`)}</td>
                <td className={TD_CLASS}>
                  <span className="text-muted-foreground">{t('automations_status_coming')}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[13px] text-muted-foreground">{t('automations_footer')}</p>
    </div>
  )
}
