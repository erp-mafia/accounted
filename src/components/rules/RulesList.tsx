'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { EllipsisHorizontalIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { TH_CLASS, TD_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { Skeleton } from '@/components/ui/skeleton'
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
import { ruleOneClick, ruleOrigin, type RuleMode, type RuleOneClick, type RuleRow } from '@/lib/rules/model'
import { DIRECT_BOOKING_ON, type DirectBookingSettings } from '@/lib/transactions/direct-booking'
import { ruleTitle } from './rule-text'

const LADDER: RuleMode[] = ['proposed', 'propose', 'auto', 'paused']

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
      variant="outline"
      className={cn(
        'font-normal',
        mode === 'proposed' && 'text-warning',
        mode === 'auto' && 'text-success',
        mode === 'paused' && 'text-muted-foreground',
      )}
    >
      {t(`mode_${mode}`)}
    </Badge>
  )
}

/**
 * Regler (UI v2 PR 5): every counterparty rule as one sentence, on the trust
 * ladder. The bar at the top is the explanation: a rule starts as a
 * suggestion, proposes once confirmed, and (with the autopilot tier) books
 * on its own after five clean hits. A correction shows in the Rättad column.
 * Ett klick (accounted#130) says whether a hit books from the row's Bokför
 * without a review, by the same decision the transactions page makes, and
 * its switch makes the rule always ask.
 */
export default function RulesList() {
  const t = useTranslations('rules')
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { data: payload, error, isLoading, mutate } = useSWR<RulesPayload>('/api/rules', fetchRules)
  const data = payload?.rules
  const directBooking = payload?.directBooking ?? DIRECT_BOOKING_ON
  const [search, setSearch] = useState('')
  const [step, setStep] = useState<RuleMode | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const rows = useMemo(() => {
    const all = data ?? []
    const q = search.trim().toLowerCase()
    return all.filter((r) => (!step || r.mode === step) && (!q || r.counterparty_name.includes(q) || r.debit_account.includes(q) || r.credit_account.includes(q)))
  }, [data, search, step])

  const countFor = (m: RuleMode) => (data ?? []).filter((r) => r.mode === m).length

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

  return (
    <div className="stagger-enter">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ToolbarSearch placeholder={t('search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="ml-auto text-xs tabular-nums text-muted-foreground" data-ph-mask>
          {t('count', { count: (data ?? []).length })}
        </span>
      </div>

      <div className="mb-3 flex overflow-hidden rounded-lg border border-border" role="tablist" aria-label={t('ladder_label')}>
        {LADDER.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={step === m}
            title={t(`ladder_${m}_help`)}
            onClick={() => setStep(step === m ? null : m)}
            className={cn(
              'flex h-10 flex-1 items-center justify-center gap-2 border-r border-border px-2 text-[12.5px] transition-colors duration-150 last:border-r-0',
              step === m ? 'bg-secondary text-foreground shadow-[inset_0_-2px_0_hsl(var(--foreground))]' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
          >
            <span className="truncate">{t(`mode_${m}`)}</span>
            <span className="font-medium tabular-nums text-foreground" data-ph-mask>
              {countFor(m) || '–'}
            </span>
          </button>
        ))}
      </div>

      <div className="-mx-5 overflow-x-auto px-5 md:-mx-6 md:px-6">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={cn(TH_CLASS, '!pl-0 w-full')}>{t('th_rule')}</th>
              <th className={TH_CLASS}>{t('th_origin')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('th_hits')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('th_corrections')}</th>
              <th className={TH_CLASS}>{t('th_mode')}</th>
              <th className={TH_CLASS}>{t('th_one_click')}</th>
              <th className={TH_CLASS}>{t('th_last')}</th>
              <th className={cn(TH_CLASS, '!pr-0')} aria-hidden="true"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [1, 2, 3].map((i) => (
                <tr key={i} aria-busy>
                  <td colSpan={8} className={cn(TD_CLASS, '!pl-0')}>
                    <Skeleton className="h-4 w-64" />
                  </td>
                </tr>
              ))
            ) : error ? (
              <tr>
                <td colSpan={8} className={cn(TD_CLASS, 'py-8 text-muted-foreground')}>
                  {t('load_failed')}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className={cn(TD_CLASS, 'py-8 text-muted-foreground')}>
                  {t('empty')}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="group transition-colors duration-150 hover:bg-secondary/35">
                  <td className={cn(TD_CLASS, '!pl-0')}>
                    <Link href={`/rules/${r.id}`} className="hover:underline underline-offset-2">
                      {ruleTitle(r)}
                    </Link>
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>{t(`origin_${ruleOrigin(r.source)}`)}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{r.occurrence_count}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums', r.corrections === 0 && 'text-muted-foreground')}>
                    {r.corrections || '–'}
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                    {/* Chips mark exceptions: a suggestion waiting for you or
                        a paused rule. A working rule reads as muted text. */}
                    {r.mode === 'proposed' || r.mode === 'paused' ? (
                      <ModeChip mode={r.mode} />
                    ) : (
                      <span className="text-muted-foreground">{t(`mode_${r.mode}`)}</span>
                    )}
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                    <OneClickControl
                      rule={r}
                      directBooking={directBooking}
                      disabled={!canWrite || busyId === r.id}
                      onChange={(alwaysReview) => void setAlwaysReview(r, alwaysReview)}
                    />
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>
                    {r.last_seen_date ? formatDate(r.last_seen_date) : '–'}
                  </td>
                  <td className={cn(TD_CLASS, '!pr-0 text-right')}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
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
                          <DropdownMenuItem onClick={() => void setMode(r, 'propose')}>{t('resume')}</DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onClick={() => void setMode(r, 'paused')}>{t('pause')}</DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
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
