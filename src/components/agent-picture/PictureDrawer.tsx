'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { AgentMemoryPanel } from '@/components/settings/AgentMemoryPanel'
import { AgentSkillsPanel } from '@/components/settings/AgentSkillsPanel'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { SlideOver, SlideOverBody, SlideOverContent, SlideOverHeader } from '@/components/ui/slide-over'
import { StatusGlyph, type StatusTone } from '@/components/ui/status-glyph'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { PictureCheckLine, PictureChecks, PictureCheckStatus, PictureKnowledge } from '@/lib/agent-context/agent-picture'

export type PictureTab = 'context' | 'checks' | 'memory' | 'knowledge'

const TABS: readonly PictureTab[] = ['context', 'checks', 'memory', 'knowledge']

const TONE: Record<PictureCheckStatus, StatusTone> = { agrees: 'ok', attention: 'warning', unknown: 'info' }

/** The typed reasons a check gives for not running (lib/unexplained CheckRefusalCode), each with a sentence in wiki.picture.reasons. */
const REASONS = new Set([
  'CASH_METHOD',
  'NO_FISCAL_PERIOD',
  'ACCOUNT_ROLE_UNAVAILABLE',
  'FX_RATE_MISSING',
  'NO_BANK_BALANCE',
  'FOREIGN_CURRENCY_ACCOUNT',
  'SHARED_LEDGER_ACCOUNT',
  'SKATTEKONTO_NOT_CONNECTED',
  'NO_SKATTEVERKET_BALANCE',
  'NOT_VAT_REGISTERED',
  'NO_DECLARED_PERIODS',
  'SOURCE_FAILED',
])

/**
 * What is behind a row of the company's card, in the app's slide-over, one
 * tab per row: the briefing's sections (handed in by the page that loads
 * them), the check lines with where each is handled, the memory panel, and
 * the knowledge list followed by the curated workflows.
 */
export function PictureDrawer({
  tab,
  onTabChange,
  onClose,
  companyName,
  contextTab,
  checks,
  knowledge,
  when,
}: {
  tab: PictureTab | null
  onTabChange: (tab: PictureTab) => void
  onClose: () => void
  companyName: string | null
  /** The Kontext tab: the sections the page already loads from the briefing. */
  contextTab: ReactNode
  checks: PictureChecks | null
  knowledge: PictureKnowledge
  /** An instant in words: today with its time, another day by its date. */
  when: (instant: string) => string
}) {
  const t = useTranslations('wiki')
  return (
    <SlideOver open={tab !== null} onOpenChange={(open) => !open && onClose()}>
      <SlideOverContent className="w-[560px]" aria-describedby={undefined}>
        <SlideOverHeader kicker={companyName ? <span data-ph-mask="">{companyName}</span> : undefined} title={t('picture.drawer_title')} />
        {tab !== null && (
          <>
            <div className="px-5 pt-3">
              <SegmentedControl
                aria-label={t('picture.tabs_label')}
                value={tab}
                onChange={onTabChange}
                options={TABS.map((value) => ({ value, label: t(`picture.row_${value}`) }))}
              />
            </div>
            <SlideOverBody className="space-y-5">
              {tab === 'context' && (
                <>
                  <div className="text-[13px] text-foreground/80">{t('picture.context_intro')}</div>
                  {contextTab}
                </>
              )}
              {tab === 'checks' && <ChecksTab checks={checks} when={when} />}
              {tab === 'memory' && <AgentMemoryPanel />}
              {tab === 'knowledge' && <KnowledgeTab knowledge={knowledge} />}
            </SlideOverBody>
          </>
        )}
      </SlideOverContent>
    </SlideOver>
  )
}

function ChecksTab({ checks, when }: { checks: PictureChecks | null; when: (instant: string) => string }) {
  const t = useTranslations('wiki')
  if (!checks) return <div className="text-[13px] text-foreground/80">{t('picture.checks_unreadable')}</div>
  return (
    <>
      <div className="text-[13px] text-foreground/80">{t('picture.checks_intro')}</div>
      <ul>
        {checks.lines.map((line) => (
          <CheckRow key={line.id} line={line} when={when} />
        ))}
        {checks.queue_unavailable && (
          <li className="flex items-start gap-2.5 border-b-hairline py-2.5 last:border-b-0">
            <StatusGlyph tone="info" className="mt-0.5 shrink-0" />
            <span className="text-[13px] text-strong">{t('picture.checks_queue_unavailable')}</span>
          </li>
        )}
      </ul>
      {checks.truncated > 0 && <div className="text-xs text-muted-foreground">{t('picture.checks_truncated', { count: checks.truncated })}</div>}
    </>
  )
}

function CheckRow({ line, when }: { line: PictureCheckLine; when: (instant: string) => string }) {
  const t = useTranslations('wiki')
  const locale = useLocale()
  const name = line.check_id === 'bank_feed' ? t('picture.check_bank_feed') : ((locale === 'en' ? line.name_en : line.name_sv) ?? line.check_id)
  // A date holds for the day; an instant is when the source was last read.
  const at = line.as_of ? (line.as_of.length > 10 ? when(line.as_of) : formatDate(line.as_of)) : null

  let state: string
  if (line.status === 'agrees') {
    state = line.check_id === 'bank_feed' ? (at ? t('picture.check_feed_current', { when: at }) : t('picture.check_agrees')) : at ? t('picture.check_agrees_at', { when: at }) : t('picture.check_agrees')
  } else if (line.status === 'attention') {
    state =
      line.check_id === 'bank_feed'
        ? at
          ? t('picture.check_feed_behind', { when: at })
          : t('picture.check_feed_behind_never')
        : line.unit === 'count' || line.difference === null
          ? t('picture.check_things', { count: line.things ?? 1 })
          : t('check_difference', { amount: formatCurrency(line.difference) })
  } else {
    state = line.reason_code && REASONS.has(line.reason_code) ? t(`picture.reasons.${line.reason_code}`) : t('picture.check_unknown')
  }

  return (
    <li className="flex items-start gap-2.5 border-b-hairline py-2.5 last:border-b-0">
      <StatusGlyph tone={TONE[line.status]} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="break-words text-[13px] text-strong">
          {name}
          {line.subject ? <span data-ph-mask="">{`: ${line.subject}`}</span> : null}
        </div>
        <div className="text-xs tabular-nums text-muted-foreground">{state}</div>
      </div>
      {line.href && (
        <Link href={line.href} className="shrink-0 text-xs font-medium text-strong underline-offset-2 hover:underline">
          {t('picture.check_open')}
        </Link>
      )}
    </li>
  )
}

function KnowledgeTab({ knowledge }: { knowledge: PictureKnowledge }) {
  const t = useTranslations('wiki')
  const tSkills = useTranslations('skills_registry')
  return (
    <>
      <AgentSkillsPanel />
      <section aria-labelledby="agent-picture-workflows">
        <h3 id="agent-picture-workflows" className="border-b-hairline pb-2 text-xs font-medium text-foreground/80">
          {t('picture.knowledge_workflows', { count: knowledge.workflows.length })}
        </h3>
        <ul>
          {knowledge.workflows.map((id) => (
            <li key={id} className="border-b-hairline py-2.5 text-[13px] text-strong last:border-b-0">
              {tSkills(`skills.${id}.name`)}
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}
