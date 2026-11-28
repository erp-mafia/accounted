'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { EllipsisHorizontalIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ToolbarSearch, TOOLBAR_SEARCH_END_CLASS } from '@/components/ui/toolbar-search'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { TH_CLASS, TD_CLASS, HOVER_REVEAL_CLASS, LIST_BLEED_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { BrandMark } from '@/components/parties/BrandMark'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { ruleCategoryAccount, ruleOneClick, type RuleMode, type RuleOneClick, type RuleRow } from '@/lib/rules/model'
import { DIRECT_BOOKING_ON, type DirectBookingSettings } from '@/lib/transactions/direct-booking'
import { accountLabel, counterpartyTitle, ruleTitle } from './rule-text'

const LADDER: RuleMode[] = ['proposed', 'propose', 'auto', 'paused']
type Filter = 'all' | RuleMode
const COLUMNS = 6

interface RulesPayload {
  rules: RuleRow[]
  directBooking: DirectBookingSettings
}

async function fetchRules(url: string): Promise<RulesPayload> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  const json = (await res.json()) as { data?: RuleRow[]; direct_booking?: DirectBookingSettings }
  return { rules: json.data ?? [], directBooking: json.direct_booking ?? DIRECT_BOOKING_ON }
}

/** What the Ett klick cell says next to its switch. */
export function oneClickText(t: (key: string, values?: Record<string, number>) => string, oneClick: RuleOneClick): string {
  if (oneClick.kind === 'hits') return t('one_click_hits', { count: oneClick.remaining })
  const keys: Record<Exclude<RuleOneClick['kind'], 'hits'>, string> = {
    yes: 'one_click_yes',
    company_off: 'one_click_company_off',
    always_review: 'one_click_always_review',
    import: 'one_click_import',
    paused: 'one_click_paused',
    proposed: 'one_click_proposed',
    vat_unknown: 'one_click_vat_unknown',
  }
  return t(keys[oneClick.kind])
}

/**
 * Whether a rule's hit books with one click, and the switch that makes the
 * rule always ask (categorization_templates.always_review). The switch is on
 * while the rule may book with one click; the text says whether it does now.
 */
export function OneClickControl({
  rule,
  directBooking,
  disabled,
  onChange,
}: {
  rule: RuleRow
  directBooking: DirectBookingSettings
  disabled: boolean
  onChange: (alwaysReview: boolean) => void
}) {
  const t = useTranslations('rules')
  const oneClick = ruleOneClick(rule, directBooking)
  return (
    <span className="inline-flex items-center gap-2">
      <Switch
        checked={!rule.always_review}
        onCheckedChange={(on) => onChange(!on)}
        disabled={disabled}
        aria-label={t('one_click_switch_label', { rule: ruleTitle(rule) })}
      />
      <span className={cn(oneClick.kind !== 'yes' && 'text-muted-foreground')}>{oneClickText(t, oneClick)}</span>
    </span>
  )
}

/** PATCH /api/rules/[id] with always_review; resolves true when it saved. */
export async function saveAlwaysReview(ruleId: string, alwaysReview: boolean): Promise<{ ok: true } | { ok: false; status: number; body: unknown }> {
  const res = await fetch(`/api/rules/${ruleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ always_review: alwaysReview }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || (body as { error?: unknown }).error) return { ok: false, status: res.status, body }
  return { ok: true }
}

export function ModeChip({ mode }: { mode: RuleMode }) {
  const t = useTranslations('rules')
  return (
    <Badge
      variant={mode === 'proposed' ? 'warning' : 'outline'}
      className={cn(
        'font-normal',
        mode === 'auto' && 'text-success',
        mode === 'paused' && 'text-muted-foreground',
      )}
    >
      {t(`mode_${mode}`)}
    </Badge>
  )
}

/**
 * Regler (UI v2 PR 5): every counterparty rule as one line, filtered by its
 * step on the trust ladder: a rule starts as a suggestion, proposes once
 * confirmed, and (with the autopilot tier) books on its own after five clean
 * hits. The ladder is the toolbar's segmented control; a row carries a chip
 * only when its rule waits for you or is paused (chips mark exceptions), and
 * where it came from stays on the rule's own page. A correction shows in the
 * Rättad column. Ett klick (accounted#130) says whether a hit books from the
 * row's Bokför without a review, by the same decision the transactions page
 * makes, and its switch makes the rule always ask.
 */
export default function RulesList() {
  const t = useTranslations('rules')
  const tCommon = useTranslations('common')
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { data: payload, error, isLoading, mutate } = useSWR<RulesPayload>('/api/rules', fetchRules)
  const data = payload?.rules
  const directBooking = payload?.directBooking ?? DIRECT_BOOKING_ON
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [busyId, setBusyId] = useState<string | null>(null)

  const rows = useMemo(() => {
    const all = data ?? []
    const q = search.trim().toLowerCase()
    return all.filter((r) => (filter === 'all' || r.mode === filter) && (!q || r.counterparty_name.includes(q) || r.debit_account.includes(q) || r.credit_account.includes(q)))
  }, [data, search, filter])

  const countFor = (m: RuleMode) => (data ?? []).filter((r) => r.mode === m).length
  // Bokför själv waits for the autopilot tier: the segment shows once a rule
  // is on that step (or while it is the chosen filter), not as an empty promise.
  const steps = LADDER.filter((m) => m !== 'auto' || countFor(m) > 0 || filter === m)
  const hasRules = (data?.length ?? 0) > 0

  async function setMode(rule: RuleRow, mode: RuleMode) {
    setBusyId(rule.id)
    try {
      const res = await fetch(`/api/rules/${rule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.error) {
        toast({ title: t('toast_failed'), description: getErrorMessage(body, { statusCode: res.status }), variant: 'destructive' })
        return
      }
      toast({ title: mode === 'paused' ? t('toast_paused') : t('toast_resumed') })
      await mutate()
    } finally {
      setBusyId(null)
    }
  }

  async function setAlwaysReview(rule: RuleRow, alwaysReview: boolean) {
    setBusyId(rule.id)
    try {
      const saved = await saveAlwaysReview(rule.id, alwaysReview)
      if (!saved.ok) {
        toast({ title: t('toast_failed'), description: getErrorMessage(saved.body, { statusCode: saved.status }), variant: 'destructive' })
        return
      }
      toast({ title: alwaysReview ? t('toast_always_review_on') : t('toast_always_review_off') })
      await mutate()
    } finally {
      setBusyId(null)
    }
  }

  // First time: one sentence where the list would be, no toolbar over nothing.
  if (!isLoading && !error && !hasRules) {
    return <EmptyState title={t('empty_title')} description={t('empty_description')} />
  }

  // The ladder's steps first, Alla last with the whole count (V7 list toolbars).
  const filters = [
    ...steps.map((m) => ({ value: m as Filter, label: t(`filter_${m}`), count: countFor(m) })),
    { value: 'all' as Filter, label: t('filter_all'), count: data?.length ?? 0 },
  ]

  return (
    <div className="stagger-enter space-y-4">
      {/* A failed refresh keeps the rows under one line (Stil v3 states). */}
      {error && data && (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void mutate() }}>{tCommon('refresh_failed')}</AttnLine>
      )}

      {/* One toolbar row: the ladder step, then the search at the right end (V7 list toolbars). */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="max-w-full overflow-x-auto">
          <SegmentedControl value={filter} onChange={setFilter} options={filters} aria-label={t('ladder_label')} />
        </div>
        <ToolbarSearch
          placeholder={t('search')}
          aria-label={t('search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          containerClassName={TOOLBAR_SEARCH_END_CLASS}
        />
      </div>

      <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={cn(TH_CLASS, 'w-full')}>{t('th_rule')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('th_hits')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('th_corrections')}</th>
              <th className={TH_CLASS}>{t('th_one_click')}</th>
              <th className={TH_CLASS}>{t('th_last')}</th>
              <th className={cn(TH_CLASS, 'w-10')} aria-hidden="true"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              // animate-late: LateReveal's hold-back on the row itself, so a
              // fast load never flashes the skeleton rows. Shaped like the rows.
              [1, 2, 3].map((i) => (
                <tr key={i} aria-busy className="animate-late">
                  <td className={TD_CLASS}>
                    <Skeleton className="h-4 w-64" />
                  </td>
                  <td className={TD_CLASS}>
                    <Skeleton className="ml-auto h-4 w-6" />
                  </td>
                  <td className={TD_CLASS}>
                    <Skeleton className="ml-auto h-4 w-6" />
                  </td>
                  <td className={TD_CLASS}>
                    <Skeleton className="h-4 w-28" />
                  </td>
                  <td className={TD_CLASS}>
                    <Skeleton className="h-4 w-20" />
                  </td>
                  <td className={TD_CLASS} />
                </tr>
              ))
            ) : error && !data ? (
              <tr>
                <td colSpan={COLUMNS} className="px-2">
                  <LoadError title={t('load_failed')} onRetry={() => void mutate()} />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              // No hits for the search or the step: one muted line with the way back.
              <tr>
                <td colSpan={COLUMNS} className={cn(TD_CLASS, 'text-muted-foreground')}>
                  {t('no_matches')}{' '}
                  <button
                    type="button"
                    className={QUIET_LINK_CLASS}
                    onClick={() => {
                      setSearch('')
                      setFilter('all')
                    }}
                  >
                    {tCommon('clear_search')}
                  </button>
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="group transition-colors duration-150 hover:bg-secondary/35">
                  {/* py-2.5 keeps the 22px mark inside the 44px row. */}
                  <td className={cn(TD_CLASS, 'max-w-0 min-w-[240px] py-2.5')}>
                    <div className="flex min-w-0 items-center gap-2">
                      <BrandMark name={counterpartyTitle(r.counterparty_name)} className="shrink-0" />
                      <Link href={`/rules/${r.id}`} title={ruleTitle(r)} className="min-w-0 truncate underline-offset-4 hover:underline">
                        <span className="text-foreground">{counterpartyTitle(r.counterparty_name)}</span>
                        <span className="text-muted-foreground"> → {accountLabel(ruleCategoryAccount(r))}</span>
                      </Link>
                      {/* Chips mark exceptions: a suggestion waiting for you or
                          a paused rule. A working rule carries none. */}
                      {(r.mode === 'proposed' || r.mode === 'paused') && (
                        <span className="shrink-0">
                          <ModeChip mode={r.mode} />
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{r.occurrence_count}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums', r.corrections === 0 && 'text-muted-foreground')}>
                    {r.corrections || '–'}
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                    {/* A flex box, not a line box: the inline switch would add 4px to the row. */}
                    <div className="flex">
                      <OneClickControl
                        rule={r}
                        directBooking={directBooking}
                        disabled={!canWrite || busyId === r.id}
                        onChange={(alwaysReview) => void setAlwaysReview(r, alwaysReview)}
                      />
                    </div>
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground date-figures')}>
                    {r.last_seen_date ? formatDate(r.last_seen_date) : '–'}
                  </td>
                  {/* py-2 and a flex box keep the 28px menu button inside the 44px row. */}
                  <td className={cn(TD_CLASS, 'py-2')}>
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn('text-muted-foreground hover:text-foreground data-[state=open]:opacity-100', HOVER_REVEAL_CLASS)}
                            aria-label={t('more')}
                            disabled={busyId === r.id}
                          >
                            <EllipsisHorizontalIcon className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/rules/${r.id}`}>{t('open')}</Link>
                          </DropdownMenuItem>
                          {r.mode === 'paused' ? (
                            <DropdownMenuItem disabled={!canWrite} onClick={() => void setMode(r, 'propose')}>{t('resume')}</DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem disabled={!canWrite} onClick={() => void setMode(r, 'paused')}>{t('pause')}</DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
