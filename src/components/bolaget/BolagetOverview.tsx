'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { ChevronRightIcon } from '@/components/icons'
import { LIST_BLEED_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { BolagetHubAccess } from '@/lib/bolaget/hub'
import { BolagetHeader } from './BolagetHeader'
import { overviewFacts, type CommitmentsAnswer, type MeetingAnswer, type RegisterAnswer } from './overview-facts'

/** A register's answer, or null when it is closed here or the read failed. */
async function read<T>(url: string): Promise<{ data: T | null; failed: boolean }> {
  try {
    const res = await fetch(url)
    if (!res.ok) return { data: null, failed: true }
    const body = (await res.json()) as { data?: T }
    return { data: body.data ?? null, failed: !body.data }
  } catch {
    // Safe to drop: the register's line is left out and the page says that
    // part of the overview could not be read (load_failed); the register's
    // own page reports the failure in full.
    return { data: null, failed: true }
  }
}

const closed = { data: null, failed: false }

interface Loaded {
  register: RegisterAnswer | null
  meetings: MeetingAnswer | null
  commitments: CommitmentsAnswer | null
  failed: boolean
}

/**
 * Bolaget, Översikt: one calm line per register, each leading to its tab.
 * No number cards. Reads the answers the register pages already read; a
 * register that is closed for the company, or whose read failed, has no line.
 */
export function BolagetOverview({ access }: { access: BolagetHubAccess }) {
  const t = useTranslations('bolaget_hub')
  const tCommon = useTranslations('common')
  const tNav = useTranslations('nav')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // Bumped by "Försök igen" to read the registers again.
  const [attempt, setAttempt] = useState(0)
  const retry = () => {
    setLoaded(null)
    setAttempt((n) => n + 1)
  }

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      access.registers ? read<RegisterAnswer>('/api/bolaget/share-register') : Promise.resolve(closed),
      // The meetings follow the whole rollout (hub.ts): a company with the registers alone has none to read.
      access.money ? read<MeetingAnswer>('/api/bolaget/meetings') : Promise.resolve(closed),
      access.agreements ? read<CommitmentsAnswer>('/api/commitments') : Promise.resolve(closed),
    ]).then(([register, meetings, commitments]) => {
      if (cancelled) return
      setLoaded({
        register: register.data,
        meetings: meetings.data,
        commitments: commitments.data,
        failed: register.failed || meetings.failed || commitments.failed,
      })
    })
    return () => {
      cancelled = true
    }
  }, [access.registers, access.money, access.agreements, attempt])

  const facts = useMemo(
    () => (loaded ? overviewFacts({ today: todayIsoStockholm(), register: loaded.register, meetings: loaded.meetings, commitments: loaded.commitments }) : null),
    [loaded],
  )

  const lines: Array<{ key: string; href: string; label: string; text: React.ReactNode }> = []
  if (facts?.owners) {
    const o = facts.owners
    lines.push({
      key: 'owners',
      href: '/bolaget/aktiebok',
      label: t('row.owners'),
      text:
        o.holders === 0 ? (
          <span className="text-muted-foreground">{t('owners_empty')}</span>
        ) : (
          <>
            {t('owners_summary', { count: o.holders, shares: o.shares })}
            {o.allocation === 'all' && <span className="text-muted-foreground">, {t('owners_all_allocated')}</span>}
            {o.allocation === 'part' && o.settings_shares != null && (
              <span className="text-attn">
                , {t(o.register_shares > o.settings_shares ? 'owners_over_allocated' : 'owners_part_allocated', { register: o.register_shares, settings: o.settings_shares })}
              </span>
            )}
          </>
        ),
    })
  }
  if (facts?.board) {
    const b = facts.board
    lines.push({
      key: 'board',
      href: '/bolaget/styrelse',
      label: t('row.board'),
      text:
        b.members.length === 0 && !b.signatory_rule ? (
          <span className="text-muted-foreground">{t('board_empty')}</span>
        ) : (
          <>
            {b.members.length > 0 && (
              <>
                {t('board_summary', { count: b.members.length })}
                <span className="text-muted-foreground">: </span>
                <span data-ph-mask="">{b.members.join(', ')}</span>
              </>
            )}
            {b.signatory_rule && (
              <span className="text-muted-foreground" data-ph-mask="">
                {b.members.length > 0 ? ' · ' : ''}
                {t('signatory', { rule: b.signatory_rule })}
              </span>
            )}
          </>
        ),
    })
  }
  if (facts?.next_meeting) {
    const m = facts.next_meeting
    lines.push({
      key: 'next_meeting',
      href: '/bolaget/moten',
      label: t('row.next_meeting'),
      text:
        m === 'none' ? (
          <span className="text-muted-foreground">{t('meeting_none')}</span>
        ) : (
          <>
            <span className="date-figures">{formatDate(m.date)}</span> <span data-ph-mask="">{m.title}</span>
          </>
        ),
    })
  }
  if (facts?.payments) {
    const p = facts.payments
    lines.push({
      key: 'payments',
      href: '/bolaget/avtal',
      label: t('row.payments'),
      text: (
        <>
          {p.next ? (
            <>
              <span className="date-figures">{formatDate(p.next.due_on)}</span> <span data-ph-mask="">{p.next.title}</span>{' '}
              <span className="whitespace-nowrap tabular-nums">{formatCurrency(p.next.amount, p.next.currency)}</span>
              {p.others > 0 && <span className="text-muted-foreground"> · {t('more', { count: p.others })}</span>}
            </>
          ) : (
            p.missed === 0 && <span className="text-muted-foreground">{t('payments_none')}</span>
          )}
          {p.missed > 0 && (
            <span className="text-attn">
              {p.next ? ' · ' : ''}
              {t('payments_missed', { count: p.missed })}
            </span>
          )}
        </>
      ),
    })
  }
  if (facts?.agreements) {
    lines.push({
      key: 'agreements',
      href: '/bolaget/avtal',
      label: t('row.agreements'),
      text: t('agreements_summary', { count: facts.agreements.active }),
    })
  }

  return (
    <div className="space-y-8">
      <BolagetHeader title={tNav('v3_overview')} subtitle={t('subtitle')} help={t('help')} />
      {!loaded ? (
        <LateReveal className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </LateReveal>
      ) : loaded.failed && lines.length === 0 ? (
        <LoadError onRetry={retry} />
      ) : (
        <div className="space-y-3">
          {loaded.failed && <AttnLine action={{ label: tCommon('retry'), onClick: retry }}>{t('load_failed')}</AttnLine>}
          <ul className={cn(LIST_BLEED_CLASS, 'stagger-enter border-t-hairline text-[13px]')}>
            {lines.map((line) => (
              <li key={line.key} className="border-b-hairline">
                <Link
                  href={line.href}
                  className="flex min-h-11 min-w-0 items-center gap-4 px-2 py-3 transition-colors duration-150 hover:bg-secondary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {/* The fact wraps instead of being cut (a firmateckning is read whole); on a phone it sits under its label. */}
                  <span className="grid min-w-0 flex-1 gap-x-4 gap-y-0.5 sm:grid-cols-[10rem_minmax(0,1fr)]">
                    <span className="text-muted-foreground">{line.label}</span>
                    <span className="min-w-0 text-foreground">{line.text}</span>
                  </span>
                  <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
