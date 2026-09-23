'use client'

import { useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  hitsUntilAuto,
  ruleOrigin,
  ruleStep,
  ruleThen,
  ruleWhen,
  RULE_LADDER,
  type RuleMode,
  type RuleRow,
} from '@/lib/rules/model'
import type { RuleMatch } from '@/lib/rules/service'
import { ModeChip } from './RulesList'
import { accountLabel, counterpartyTitle, ruleTitle, vatLabelKey } from './rule-text'

interface Payload {
  rule: RuleRow
  matches: RuleMatch[]
}

async function fetchRule(url: string): Promise<Payload> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  const json = (await res.json()) as { data: Payload }
  return json.data
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-border px-2.5 py-0.5 text-xs">{children}</span>
}

/**
 * One rule (UI v2 PR 5): Om / Gör as pills, the sentence Accounted reads
 * the rule as, this year's matches, and the side with origin, trust and
 * links. One primary action: pause or resume. The auto step is shown on the
 * ladder and explained; it becomes reachable with the autopilot tier.
 */
export default function RuleDetail({ id }: { id: string }) {
  const t = useTranslations('rules')
  const { toast } = useToast()
  const { data, isLoading, error, mutate } = useSWR<Payload>(`/api/rules/${id}`, fetchRule)
  const [busy, setBusy] = useState(false)

  async function setMode(mode: RuleMode) {
    setBusy(true)
    try {
      const res = await fetch(`/api/rules/${id}`, {
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
      setBusy(false)
    }
  }

  if (isLoading) return <p className="text-[13px] text-muted-foreground">{t('loading')}</p>
  if (error || !data) return <p className="text-[13px] text-muted-foreground">{t('not_found')}</p>

  const { rule, matches } = data
  const step = ruleStep(rule.mode)
  const remaining = hitsUntilAuto(rule)
  const when = ruleWhen(rule)
  const then = ruleThen(rule)
  const dir = when.find((w) => w.kind === 'direction')?.value
  const vatKey = rule.vat_treatment ? vatLabelKey(rule.vat_treatment) : null
  const vatText = vatKey ? t(vatKey) : rule.vat_treatment ?? ''

  const read = t('read_sentence', {
    counterparty: counterpartyTitle(rule.counterparty_name),
    direction: t(`direction_${dir ?? 'unknown'}`),
    account: accountLabel(then[0].value),
    vat: vatText ? t('read_vat', { vat: vatText }) : '',
    outcome: rule.mode === 'auto' ? t('read_outcome_auto') : t('read_outcome_propose'),
  })

  const stepText = [
    t(`origin_${ruleOrigin(rule.source)}`) + (rule.created_at ? ` · ${formatDate(rule.created_at)}` : ''),
    rule.mode === 'paused'
      ? t('step_paused', { date: rule.paused_at ? formatDate(rule.paused_at) : '' })
      : t('step_propose', { hits: rule.occurrence_count, corrections: rule.corrections }),
    rule.mode === 'auto' ? t('step_auto_on') : t('step_auto_soon'),
  ]

  return (
    <>
      <PageHeader
        title={<span data-ph-mask>{ruleTitle(rule)}</span>}
        action={
          rule.mode === 'paused' ? (
            <Button size="sm" disabled={busy} onClick={() => void setMode('propose')}>
              {t('resume')}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void setMode('paused')}>
              {t('pause')}
            </Button>
          )
        }
      />

      <div className="mb-5 flex overflow-hidden rounded-lg border border-border">
        {RULE_LADDER.map((m, i) => (
          <div
            key={m}
            className={cn(
              'flex min-w-0 flex-1 flex-col justify-center gap-0.5 border-r border-border px-3 py-2 last:border-r-0',
              i === step && 'bg-secondary shadow-[inset_0_-2px_0_hsl(var(--foreground))]',
              i === step && rule.mode === 'paused' && 'shadow-[inset_0_-2px_0_hsl(var(--destructive))]',
            )}
          >
            <span
              className={cn(
                'truncate text-[10.5px] font-semibold uppercase tracking-[0.06em]',
                i < step ? 'text-success' : i === step ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {t(`mode_${m}`)}
              {i === step && rule.mode === 'paused' ? ` · ${t('mode_paused').toLowerCase()}` : ''}
            </span>
            <span className={cn('truncate text-[12.5px]', i > step ? 'text-muted-foreground/70' : 'text-foreground/80')}>
              {stepText[i]}
            </span>
          </div>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <div className="rounded-lg border border-border px-4 py-3 text-[13px]">
            <div className="flex flex-wrap items-center gap-2 py-1">
              <span className="w-10 text-muted-foreground">{t('om')}</span>
              {when.map((w) => (
                <Pill key={w.kind + w.value}>
                  {w.kind === 'counterparty' ? t('when_counterparty', { name: counterpartyTitle(w.value) }) : t(`when_direction_${w.value}`)}
                </Pill>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 py-1">
              <span className="w-10 text-muted-foreground">{t('gor')}</span>
              {then.map((x) => (
                <Pill key={x.kind + x.value}>
                  {x.kind === 'account'
                    ? t('then_account', { account: accountLabel(x.value) })
                    : x.kind === 'vat'
                      ? t('then_vat', { vat: vatText })
                      : t('then_settlement', { account: accountLabel(x.value) })}
                </Pill>
              ))}
            </div>
          </div>

          <p className="my-4 max-w-[64ch] text-[13.5px] leading-relaxed text-foreground/85">
            <span className="text-muted-foreground">{t('read_lead')}</span> {read}
          </p>

          <h2 className="mb-2 mt-6 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {t('matches_title')}
          </h2>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={cn(TH_CLASS, '!pl-0')}>{t('th_date')}</th>
                <th className={cn(TH_CLASS, 'w-full')}>{t('th_text')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_amount')}</th>
                <th className={cn(TH_CLASS, '!pr-0')}>{t('th_entry')}</th>
              </tr>
            </thead>
            <tbody>
              {matches.length === 0 ? (
                <tr>
                  <td colSpan={4} className={cn(TD_CLASS, '!pl-0 text-muted-foreground')}>
                    {t('matches_empty')}
                  </td>
                </tr>
              ) : (
                matches.map((m) => (
                  <tr key={m.id}>
                    <td className={cn(TD_CLASS, '!pl-0 whitespace-nowrap tabular-nums text-muted-foreground')}>{formatDate(m.date)}</td>
                    <td className={cn(TD_CLASS, 'max-w-0 truncate')} data-ph-mask>
                      {m.description}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums', m.amount > 0 && 'text-success')}>
                      {formatCurrency(m.amount, m.currency)}
                    </td>
                    <td className={cn(TD_CLASS, '!pr-0 whitespace-nowrap')}>
                      {m.journal_entry_id ? (
                        <Link href={`/bookkeeping/${m.journal_entry_id}`} className="underline underline-offset-2">
                          {t('open_entry')}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <aside className="text-[13px]">
          <Section title={t('sect_origin')}>
            <Kv k={t('created_from')} v={t(`origin_${ruleOrigin(rule.source)}`)} />
            <Kv k={t('since')} v={formatDate(rule.created_at)} />
            <Kv k={t('edited')} v={rule.updated_at !== rule.created_at ? formatDate(rule.updated_at) : t('never')} />
          </Section>
          <Section title={t('sect_trust')}>
            <Kv k={t('mode_label')} v={<ModeChip mode={rule.mode} />} />
            <Kv k={t('hits_label')} v={t('hits_line', { hits: rule.occurrence_count, corrections: rule.corrections })} />
            <Kv
              k={t('next_label')}
              v={
                rule.mode === 'paused'
                  ? t('next_paused')
                  : rule.mode === 'auto'
                    ? t('next_auto_on')
                    : remaining > 0
                      ? t('next_auto', { count: remaining })
                      : t('next_ready')
              }
            />
          </Section>
          <Section title={t('sect_linked')}>
            <Kv k={t('linked_transactions')} v={<Link href="/transactions" className="underline underline-offset-2">{t('open_transactions')}</Link>} />
            <Kv k={t('linked_counterparty')} v={<Link href="/parties" className="underline underline-offset-2">{counterpartyTitle(rule.counterparty_name)}</Link>} />
            <Kv k={t('linked_agents')} v={<span className="text-muted-foreground">{t('agents_same_rule')}</span>} />
          </Section>
        </aside>
      </div>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h2 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{title}</h2>
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">{children}</dl>
    </div>
  )
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0">{v}</dd>
    </>
  )
}
