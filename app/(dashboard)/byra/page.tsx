import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { cn, formatDate } from '@/lib/utils'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { fetchClientOverview } from '@/lib/clients/fetch-client-overview'
import { getDashboardAuthContext } from '../request-context'

export const dynamic = 'force-dynamic'

/**
 * Byrå cockpit home (Hem): the general overview the lean sidebar opens on.
 * Aggregates the same client-overview data as /clients into a glance:
 * client count, companies needing action, and the nearest deadline per
 * client. Byrå team members only, like the rest of the cockpit.
 */
export default async function ByraHomePage() {
  const { supabase, user } = await getDashboardAuthContext()
  if (!user) {
    redirect('/login')
  }

  const overview = await fetchClientOverview(supabase, user.id)
  if (!overview) {
    redirect('/')
  }

  const t = await getTranslations('byra')
  const tClients = await getTranslations('clients')

  const clients = overview.clients
  const needsAction = clients.filter((c) => c.unbookedCount > 0 || c.inboxCount > 0).length
  const urgentDeadlines = clients.filter(
    (c) => c.nextDeadline && c.nextDeadline.urgency !== 'upcoming',
  ).length

  // One row per client with an open deadline, most urgent first.
  const urgencyRank = { overdue: 0, action_needed: 1, upcoming: 2 } as const
  const deadlineRows = clients
    .filter((c) => c.nextDeadline)
    .sort((a, b) => {
      const rank = urgencyRank[a.nextDeadline!.urgency] - urgencyRank[b.nextDeadline!.urgency]
      if (rank !== 0) return rank
      return a.nextDeadline!.dueDate.localeCompare(b.nextDeadline!.dueDate)
    })
    .slice(0, 5)

  const stats = [
    { label: t('stats_clients'), value: clients.length },
    { label: t('stats_attention'), value: needsAction },
    { label: t('stats_deadlines'), value: urgentDeadlines },
  ]

  return (
    <div className="space-y-8">
      <PageHeader title={overview.team.name || t('home_title')} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-lg border border-border p-4">
            <div className="text-xs text-muted-foreground">{stat.label}</div>
            <div className="mt-1 font-display text-xl tabular-nums">{stat.value}</div>
          </div>
        ))}
      </div>

      <section className="space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('deadlines_title')}
        </h2>
        {deadlineRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('deadlines_empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{tClients('col_company')}</th>
                  <th className={TH_CLASS}>{tClients('col_next_deadline')}</th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {deadlineRows.map((row) => (
                  <tr key={row.companyId} className="transition-colors duration-150 hover:bg-secondary/35">
                    <td className={cn(TD_CLASS, 'font-medium text-foreground')}>{row.name}</td>
                    <td className={TD_CLASS}>
                      <span className="flex items-center gap-2">
                        {row.nextDeadline!.urgency === 'overdue' && (
                          <Badge variant="destructive">{tClients('deadline_overdue')}</Badge>
                        )}
                        {row.nextDeadline!.urgency === 'action_needed' && (
                          <Badge variant="warning">{tClients('deadline_action_needed')}</Badge>
                        )}
                        <span
                          className={cn(
                            'truncate',
                            row.nextDeadline!.urgency === 'upcoming' && 'text-muted-foreground',
                          )}
                        >
                          {row.nextDeadline!.title}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {formatDate(row.nextDeadline!.dueDate)}
                        </span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
