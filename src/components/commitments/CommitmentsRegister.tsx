'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/info-tooltip'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { LIST_BLEED_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { ArchiveBoxIcon, BriefcaseIcon, PlusIcon } from '@/components/icons'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency, formatDate, formatRowAmount } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { AgreementView, GroupLinkView, ObligationView, SecurityView } from '@/lib/commitments/types'
import { columnsWithValues, groupUpcomingPayments } from '@/lib/commitments/register-view'
import { BolagetHeader } from '@/components/bolaget/BolagetHeader'
import { OpenOnParam } from '@/components/ui/open-on-param'
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
  /** The agreement's further payments in the window, folded into this line. */
  more: number
}

const H2_CLASS = 'text-[15px] font-medium leading-[22px] text-strong'
// A kind is a quiet label over its rows, not a band (founder call 2026-10-30).
const GROUP_LABEL_CLASS = 'px-2 pb-1 pt-4 text-xs font-medium text-muted-foreground'
// The agreement's name takes the width that is left and truncates; the
// figures and dates beside it never wrap (no horizontal scroll on a laptop).
// It never truncates below a readable width: on a phone the table scrolls sideways instead.
const NAME_TD_CLASS = 'max-w-0 min-w-44 w-1/2'
const NOWRAP = 'whitespace-nowrap tabular-nums'
// Dates in a list are proportional figures (design.md, typography).
const DATE = 'whitespace-nowrap date-figures'

/** The agreement columns besides its name, each left out when no shown row fills it. */
const AGREEMENT_CELLS = {
  counterparty: (a: AgreementView) => a.counterparty_name,
  amount: (a: AgreementView) => a.amount,
  next_payment: (a: AgreementView) => a.next_payment?.due_on,
  notice: (a: AgreementView) => a.notice_deadline?.due_date,
  ends: (a: AgreementView) => a.ends_on,
}

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
  // The top bar carries the menu row's name (Företaget's sidebar).
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [loading, setLoading] = useState(true)
  const [overview, setOverview] = useState<Overview | null>(null)
  // The last load's failure, said in the page (Stil v3 states), never a toast.
  const [loadError, setLoadError] = useState<string | null>(null)
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
        setLoadError(getErrorMessage(body, { locale, fallback: t('load_failed') }))
        return
      }
      setOverview(body.data as Overview)
      setLoadError(null)
    } catch {
      setLoadError(t('load_failed'))
    } finally {
      setLoading(false)
    }
  }, [locale, t])

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
    // One line per agreement, not per payment: the first one and "+N till".
    const rows: UpcomingRow[] = groupUpcomingPayments(overview.upcoming_payments).map((p) => ({
      key: `p:${p.agreement_id}`,
      date: p.due_on,
      title: p.title,
      what: p.direction === 'in' ? t('upcoming_payment_in') : t('upcoming_payment_out'),
      amount: p.amount,
      currency: p.currency,
      missed: p.missed,
      more: p.more,
    }))
    for (const a of overview.agreements.filter((x) => x.status === 'active')) {
      for (const [key, d] of [
        ['notice', a.notice_deadline],
        ['end', a.end_deadline],
      ] as const) {
        if (d && d.due_date >= overview.today && d.due_date <= horizon) {
          rows.push({ key: `d:${a.agreement_id}:${key}`, date: d.due_date, title: a.title, what: t(`upcoming_${key}`), amount: null, currency: a.currency, missed: false, more: 0 })
        }
      }
    }
    return rows.sort((x, y) => x.date.localeCompare(y.date)).slice(0, 15)
  }, [overview, t])

  const loans = useMemo(() => (overview?.agreements ?? []).filter((a) => a.kind === 'loan'), [overview])
  const shown = useMemo(() => columnsWithValues(agreements, AGREEMENT_CELLS), [agreements])
  const columnCount = 1 + shown.size
  // "10 417 kr/mån": the period after a slash, never on a line of its own.
  const amountText = (a: AgreementView) =>
    a.amount == null ? '' : a.period && a.period !== 'one_time' ? t('amount_per_period', { amount: formatCurrency(a.amount, a.currency), period: t(`period_short.${a.period}`) }) : formatCurrency(a.amount, a.currency)
  const validity = (from: string | null, to: string | null) =>
    from && to ? t('valid_range', { from: formatDate(from), to: formatDate(to) }) : from ? t('valid_from_only', { from: formatDate(from) }) : to ? t('valid_to_only', { to: formatDate(to) }) : ''

  const saved = async (message: string) => {
    toast({ title: message })
    await load()
  }

  return (
    <div className="space-y-8">
      {/* ?new opens the "Nytt avtal" drawer: the Företaget area's create button links here. */}
      {canWrite && <OpenOnParam param="new" onOpen={() => setAgreementDialog({ agreement: null })} />}
      <BolagetHeader
        title={tNav('v3_agreements')}
        subtitle={t('subtitle')}
        help={t('help')}
        action={
          canWrite ? (
            <Button onClick={() => setAgreementDialog({ agreement: null })}>
              <PlusIcon className="h-4 w-4" />
              {t('agreement_add')}
            </Button>
          ) : undefined
        }
      />

      {loading ? (
        <LateReveal className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </LateReveal>
      ) : !overview ? (
        loadError ? (
          <LoadError
            title={t('load_failed')}
            description={loadError === t('load_failed') ? undefined : loadError}
            onRetry={() => {
              setLoading(true)
              void load()
            }}
          />
        ) : null
      ) : (
        <>
          {loadError && (
            <AttnLine action={{ label: tCommon('retry'), onClick: () => void load() }}>
              {tCommon('refresh_failed')}
            </AttnLine>
          )}
          {/* Kommande shows only when something is coming: an empty section says nothing. */}
          {upcoming.length > 0 && (
          <section className="space-y-3">
            <h2 className={H2_CLASS}>{t('upcoming_heading')}</h2>
              <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
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
                        <td className={cn(TD_CLASS, DATE)}>{formatDate(row.date)}</td>
                        <td className={cn(TD_CLASS, NAME_TD_CLASS)}>
                          <span className="block truncate" data-ph-mask="">
                            {row.title}
                          </span>
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                          {row.missed ? <span className="text-attn">{t('payment_missed')}</span> : <span className="text-muted-foreground">{row.what}</span>}
                          {row.more > 0 && <span className="text-muted-foreground"> · {t('upcoming_more', { count: row.more })}</span>}
                        </td>
                        <td className={cn(TD_CLASS, NOWRAP, 'text-right')}>{row.amount == null ? '' : formatRowAmount(row.amount, row.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
          </section>
          )}

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
              <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
                <table className="stagger-enter w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={TH_CLASS}>{t('col_agreement')}</th>
                      {shown.has('counterparty') && <th className={TH_CLASS}>{t('col_counterparty')}</th>}
                      {shown.has('amount') && <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>}
                      {shown.has('next_payment') && <th className={TH_CLASS}>{t('col_next_payment')}</th>}
                      {shown.has('notice') && <th className={TH_CLASS}>{t('col_notice')}</th>}
                      {shown.has('ends') && <th className={TH_CLASS}>{t('col_ends')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {byKind.map(([kind, rows]) => [
                      <tr key={`band-${kind}`}>
                        <td colSpan={columnCount} className={GROUP_LABEL_CLASS}>
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
                            <td className={cn(TD_CLASS, NAME_TD_CLASS)}>
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="truncate" data-ph-mask="">
                                  {a.title}
                                </span>
                                {/* Where the agreement came from, as a quiet mark: a derived
                                    agreement has no detail view of its own here. */}
                                {a.origin === 'derived' && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span tabIndex={0} aria-label={t('origin_derived')} className="inline-flex shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                        <ArchiveBoxIcon className="h-3.5 w-3.5 text-muted-foreground" />
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">{t('origin_derived')}</TooltipContent>
                                  </Tooltip>
                                )}
                              </span>
                            </td>
                            {shown.has('counterparty') && (
                              <td className={cn(TD_CLASS, 'max-w-0 min-w-28 w-1/4 text-muted-foreground')}>
                                <span className="block truncate" data-ph-mask="">
                                  {a.counterparty_name ?? ''}
                                </span>
                              </td>
                            )}
                            {shown.has('amount') && <td className={cn(TD_CLASS, NOWRAP, 'text-right')}>{amountText(a)}</td>}
                            {shown.has('next_payment') && (
                              <td className={cn(TD_CLASS, DATE)}>
                                {a.next_payment ? (
                                  a.next_payment.status === 'missed' ? (
                                    <span className="text-attn">{t('payment_missed_on', { date: formatDate(a.next_payment.due_on) })}</span>
                                  ) : (
                                    formatDate(a.next_payment.due_on)
                                  )
                                ) : (
                                  ''
                                )}
                              </td>
                            )}
                            {shown.has('notice') && <td className={cn(TD_CLASS, DATE)}>{a.notice_deadline ? formatDate(a.notice_deadline.due_date) : ''}</td>}
                            {shown.has('ends') && <td className={cn(TD_CLASS, DATE)}>{a.ends_on ? formatDate(a.ends_on) : ''}</td>}
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
                <Button variant="ghost" onClick={() => setSecurityDialog({ security: null })}>
                  <PlusIcon className="h-4 w-4" />
                  {t('security_add')}
                </Button>
              )}
            </div>
            {overview.securities.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('securities_empty')}</p>
            ) : (
              <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
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
                        <td className={cn(TD_CLASS, NOWRAP, 'text-right')}>{formatRowAmount(s.amount)}</td>
                        <td className={cn(TD_CLASS, DATE, 'text-muted-foreground')}>{validity(s.valid_from, s.valid_to)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="max-w-[760px] space-y-1 text-xs text-muted-foreground">
              <p>{t('note_securities', { text: overview.note_texts.securities_pledged ?? t('note_none') })}</p>
              <p>{t('note_contingencies', { text: overview.note_texts.contingent_liabilities ?? t('note_none') })}</p>
            </div>
          </section>

          {overview.group_structure_applies && (
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <h2 className={H2_CLASS}>{t('group_heading')}</h2>
                {canWrite && (
                  <Button variant="ghost" onClick={() => setGroupDialog({ link: null })}>
                    <PlusIcon className="h-4 w-4" />
                    {t('group_add')}
                  </Button>
                )}
              </div>
              {overview.group_links.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">{t('group_empty')}</p>
              ) : (
                <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
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
                          <td className={cn(TD_CLASS, DATE, 'text-muted-foreground')}>{validity(g.valid_from, g.valid_to)}</td>
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
