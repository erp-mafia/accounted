'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { BriefcaseIcon } from '@/components/icons'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { AgreementView, GroupLinkView, ObligationView, SecurityView } from '@/lib/commitments/types'
import { AgreementDialog, EndAgreementDialog, GroupLinkDialog, SecurityDialog } from './CommitmentDialogs'

interface Overview {
  today: string
  agreements: AgreementView[]
  upcoming_payments: ObligationView[]
  securities: SecurityView[]
  note_texts: { securities_pledged: string | null; contingent_liabilities: string | null }
  group_links: GroupLinkView[]
  group_structure_applies: boolean
}

interface UpcomingRow {
  key: string
  date: string
  title: string
  what: string
  amount: number | null
  currency: string
  missed: boolean
}

const H2_CLASS = 'text-sm font-medium uppercase tracking-wider text-muted-foreground'
const GROUP_BAND_CLASS = 'bg-muted/30'

function addYear(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${Number(y) + 1}-${m}-${d}`
}

/**
 * Avtal och åtaganden (Bolaget): what the company has signed and promised.
 * Upcoming payments and dates first, then the agreements by kind, the
 * ställda säkerheter and eventualförpliktelser with the note texts they give
 * the årsredovisning, and the group structure for the forms that have one.
 */
export function CommitmentsRegister() {
  const t = useTranslations('bolaget_commitments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [loading, setLoading] = useState(true)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [view, setView] = useState<'active' | 'ended'>('active')
  const [agreementDialog, setAgreementDialog] = useState<{ agreement: AgreementView | null } | null>(null)
  const [ending, setEnding] = useState<AgreementView | null>(null)
  const [securityDialog, setSecurityDialog] = useState<{ security: SecurityView | null } | null>(null)
  const [groupDialog, setGroupDialog] = useState<{ link: GroupLinkView | null } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/commitments')
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: t('load_failed'), description: getErrorMessage(body, { locale, fallback: t('load_failed') }), variant: 'destructive' })
        return
      }
      setOverview(body.data as Overview)
    } finally {
      setLoading(false)
    }
  }, [locale, t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const agreements = useMemo(() => (overview?.agreements ?? []).filter((a) => a.status === view), [overview, view])
  const counts = useMemo(
    () => ({
      active: (overview?.agreements ?? []).filter((a) => a.status === 'active').length,
      ended: (overview?.agreements ?? []).filter((a) => a.status === 'ended').length,
    }),
    [overview],
  )
  const byKind = useMemo(() => {
    const groups = new Map<string, AgreementView[]>()
    for (const a of agreements) groups.set(a.kind, [...(groups.get(a.kind) ?? []), a])
    return [...groups.entries()].sort(([a], [b]) => t(`kind.${a}`).localeCompare(t(`kind.${b}`), 'sv'))
  }, [agreements, t])

  const upcoming = useMemo<UpcomingRow[]>(() => {
    if (!overview) return []
    const horizon = addYear(overview.today)
    const rows: UpcomingRow[] = overview.upcoming_payments.map((o) => ({
      key: `p:${o.obligation_id}`,
      date: o.due_on,
      title: o.agreement_title,
      what: o.direction === 'in' ? t('upcoming_payment_in') : t('upcoming_payment_out'),
      amount: o.amount,
      currency: o.currency,
      missed: o.status === 'missed',
    }))
    for (const a of overview.agreements.filter((x) => x.status === 'active')) {
      for (const [key, d] of [
        ['notice', a.notice_deadline],
        ['end', a.end_deadline],
      ] as const) {
        if (d && d.due_date >= overview.today && d.due_date <= horizon) {
          rows.push({ key: `d:${a.agreement_id}:${key}`, date: d.due_date, title: a.title, what: t(`upcoming_${key}`), amount: null, currency: a.currency, missed: false })
        }
      }
    }
    return rows.sort((x, y) => x.date.localeCompare(y.date)).slice(0, 15)
  }, [overview, t])

  const loans = useMemo(() => (overview?.agreements ?? []).filter((a) => a.kind === 'loan'), [overview])
  const amountText = (a: AgreementView) =>
    a.amount == null ? '' : a.period && a.period !== 'one_time' ? t('amount_per', { amount: formatCurrency(a.amount, a.currency), period: t(`period_per.${a.period}`) }) : formatCurrency(a.amount, a.currency)
  const validity = (from: string | null, to: string | null) =>
    from && to ? t('valid_range', { from: formatDate(from), to: formatDate(to) }) : from ? t('valid_from_only', { from: formatDate(from) }) : to ? t('valid_to_only', { to: formatDate(to) }) : ''

  const saved = async (message: string) => {
    toast({ title: message })
    await load()
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        help={<p className="text-sm">{t('help')}</p>}
        action={
          canWrite ? (
            <Button size="sm" onClick={() => setAgreementDialog({ agreement: null })}>
              {t('agreement_add')}
            </Button>
          ) : undefined
        }
      />

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : !overview ? null : (
        <>
          <section className="space-y-3">
            <h2 className={H2_CLASS}>{t('upcoming_heading')}</h2>
            {upcoming.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('upcoming_empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="stagger-enter w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={TH_CLASS}>{t('col_date')}</th>
                      <th className={TH_CLASS}>{t('col_agreement')}</th>
                      <th className={TH_CLASS}>{t('col_what')}</th>
                      <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upcoming.map((row) => (
                      <tr key={row.key} className="hover:bg-secondary/35">
                        <td className={cn(TD_CLASS, 'tabular-nums')}>{formatDate(row.date)}</td>
                        <td className={TD_CLASS} data-ph-mask="">
                          {row.title}
                        </td>
                        <td className={TD_CLASS}>
                          {row.missed ? <Badge variant="warning">{t('payment_missed')}</Badge> : <span className="text-muted-foreground">{row.what}</span>}
                        </td>
                        <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{row.amount == null ? '' : formatCurrency(row.amount, row.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className={H2_CLASS}>{t('agreements_heading')}</h2>
              <SegmentedControl
                value={view}
                onChange={setView}
                aria-label={t('agreements_heading')}
                options={[
                  { value: 'active', label: t('view_active'), count: counts.active },
                  { value: 'ended', label: t('view_ended'), count: counts.ended },
                ]}
              />
            </div>
            {agreements.length === 0 ? (
              <EmptyState
                icon={BriefcaseIcon}
                title={view === 'active' ? t('agreements_empty_title') : t('agreements_ended_empty')}
                description={view === 'active' ? t('agreements_empty_description') : undefined}
                {...(canWrite && view === 'active' ? { actionLabel: t('agreement_add'), onAction: () => setAgreementDialog({ agreement: null }) } : {})}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="stagger-enter w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={TH_CLASS}>{t('col_agreement')}</th>
                      <th className={TH_CLASS}>{t('col_counterparty')}</th>
                      <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                      <th className={TH_CLASS}>{t('col_next_payment')}</th>
                      <th className={TH_CLASS}>{t('col_notice')}</th>
                      <th className={TH_CLASS}>{t('col_ends')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byKind.map(([kind, rows]) => [
                      <tr key={`band-${kind}`} className={GROUP_BAND_CLASS}>
                        <td colSpan={6} className="px-4 py-2 text-[12.5px] font-medium text-muted-foreground">
                          {t(`kind.${kind}`)}
                        </td>
                      </tr>,
                      ...rows.map((a) => {
                        const editable = canWrite && a.origin === 'manual'
                        return (
                          <tr
                            key={a.agreement_id}
                            className={cn('hover:bg-secondary/35', editable && 'cursor-pointer')}
                            onClick={editable ? () => setAgreementDialog({ agreement: a }) : undefined}
                          >
                            <td className={TD_CLASS} data-ph-mask="">
                              <span>{a.title}</span>
                              {a.origin === 'derived' && (
                                <Badge variant="outline" className="ml-2">
                                  {t('origin_derived')}
                                </Badge>
                              )}
                            </td>
                            <td className={cn(TD_CLASS, 'text-muted-foreground')} data-ph-mask="">
                              {a.counterparty_name ?? ''}
                            </td>
                            <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{amountText(a)}</td>
                            <td className={cn(TD_CLASS, 'tabular-nums')}>
                              {a.next_payment ? (
                                a.next_payment.status === 'missed' ? (
                                  <Badge variant="warning">{t('payment_missed_on', { date: formatDate(a.next_payment.due_on) })}</Badge>
                                ) : (
                                  formatDate(a.next_payment.due_on)
                                )
                              ) : (
                                ''
                              )}
                            </td>
                            <td className={cn(TD_CLASS, 'tabular-nums')}>{a.notice_deadline ? formatDate(a.notice_deadline.due_date) : ''}</td>
                            <td className={cn(TD_CLASS, 'tabular-nums')}>{a.ends_on ? formatDate(a.ends_on) : ''}</td>
                          </tr>
                        )
                      }),
                    ])}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className={H2_CLASS}>{t('securities_heading')}</h2>
              {canWrite && (
                <Button size="sm" variant="outline" onClick={() => setSecurityDialog({ security: null })}>
                  {t('security_add')}
                </Button>
              )}
            </div>
            {overview.securities.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('securities_empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="stagger-enter w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={TH_CLASS}>{t('col_type')}</th>
                      <th className={TH_CLASS}>{t('col_description')}</th>
                      <th className={TH_CLASS}>{t('col_in_favour_of')}</th>
                      <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                      <th className={TH_CLASS}>{t('col_validity')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.securities.map((s) => (
                      <tr
                        key={s.security_id}
                        className={cn('hover:bg-secondary/35', canWrite && 'cursor-pointer')}
                        onClick={canWrite ? () => setSecurityDialog({ security: s }) : undefined}
                      >
                        <td className={TD_CLASS}>{t(`security_kind.${s.kind}`)}</td>
                        <td className={TD_CLASS} data-ph-mask="">
                          {s.description}
                        </td>
                        <td className={cn(TD_CLASS, 'text-muted-foreground')} data-ph-mask="">
                          {s.in_favour_of_name ?? ''}
                        </td>
                        <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatCurrency(s.amount)}</td>
                        <td className={cn(TD_CLASS, 'tabular-nums text-muted-foreground')}>{validity(s.valid_from, s.valid_to)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="space-y-1 text-[12.5px] text-muted-foreground">
              <p>{t('note_securities', { text: overview.note_texts.securities_pledged ?? t('note_none') })}</p>
              <p>{t('note_contingencies', { text: overview.note_texts.contingent_liabilities ?? t('note_none') })}</p>
            </div>
          </section>

          {overview.group_structure_applies && (
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <h2 className={H2_CLASS}>{t('group_heading')}</h2>
                {canWrite && (
                  <Button size="sm" variant="outline" onClick={() => setGroupDialog({ link: null })}>
                    {t('group_add')}
                  </Button>
                )}
              </div>
              {overview.group_links.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">{t('group_empty')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="stagger-enter w-full border-collapse text-[13px]">
                    <thead>
                      <tr>
                        <th className={TH_CLASS}>{t('col_relation')}</th>
                        <th className={TH_CLASS}>{t('col_company')}</th>
                        <th className={TH_CLASS}>{t('col_org_number')}</th>
                        <th className={cn(TH_CLASS, 'text-right')}>{t('col_ownership')}</th>
                        <th className={cn(TH_CLASS, 'text-right')}>{t('col_votes')}</th>
                        <th className={TH_CLASS}>{t('col_validity')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.group_links.map((g) => (
                        <tr
                          key={g.group_link_id}
                          className={cn('hover:bg-secondary/35', canWrite && 'cursor-pointer')}
                          onClick={canWrite ? () => setGroupDialog({ link: g }) : undefined}
                        >
                          <td className={TD_CLASS}>{t(`relation.${g.relation}`)}</td>
                          <td className={TD_CLASS} data-ph-mask="">
                            {g.counterparty_name}
                          </td>
                          <td className={cn(TD_CLASS, 'tabular-nums text-muted-foreground')}>{g.counterparty_org_number ?? ''}</td>
                          <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{g.ownership_percent == null ? '' : `${g.ownership_percent} %`}</td>
                          <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{g.voting_percent == null ? '' : `${g.voting_percent} %`}</td>
                          <td className={cn(TD_CLASS, 'tabular-nums text-muted-foreground')}>{validity(g.valid_from, g.valid_to)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {agreementDialog && (
        <AgreementDialog
          agreement={agreementDialog.agreement}
          onClose={() => setAgreementDialog(null)}
          onEnd={(a) => {
            setAgreementDialog(null)
            setEnding(a)
          }}
          onSaved={async (created) => {
            setAgreementDialog(null)
            await saved(created ? t('agreement_created') : t('agreement_updated'))
          }}
        />
      )}
      {ending && (
        <EndAgreementDialog
          agreement={ending}
          today={overview?.today ?? ''}
          onClose={() => setEnding(null)}
          onEnded={async () => {
            setEnding(null)
            await saved(t('agreement_ended'))
          }}
        />
      )}
      {securityDialog && (
        <SecurityDialog
          security={securityDialog.security}
          loans={loans}
          onClose={() => setSecurityDialog(null)}
          onSaved={async (created) => {
            setSecurityDialog(null)
            await saved(created ? t('security_created') : t('security_updated'))
          }}
        />
      )}
      {groupDialog && (
        <GroupLinkDialog
          link={groupDialog.link}
          onClose={() => setGroupDialog(null)}
          onSaved={async (created) => {
            setGroupDialog(null)
            await saved(created ? t('group_created') : t('group_updated'))
          }}
        />
      )}
    </div>
  )
}
