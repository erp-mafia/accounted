'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { ContextGraph } from '@/components/context-graph/ContextGraph'
import { AgentMemoryPanel } from '@/components/settings/AgentMemoryPanel'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { SlideOver, SlideOverBody, SlideOverContent, SlideOverHeader } from '@/components/ui/slide-over'
import { StatusGlyph, type StatusTone } from '@/components/ui/status-glyph'
import { RawText } from '@/components/wiki/wiki-parts'
import { cn, formatCurrency } from '@/lib/utils'
import type { PictureActivity, PictureAgentCard, PictureCheckLine, PictureChecks, PictureCheckStatus } from '@/lib/agent-context/agent-picture'
import { checkDoesNotApply, orderedCheckLines } from '@/lib/agent-context/agent-picture-view'
import { PICTURE_ROWS, isPictureRow, type PictureRow } from '@/lib/agent-context/wiki-views'
import { AgentPanel, type AgentPanelCalls } from './AgentPanel'
import type { PictureWords } from './agent-card-text'

function FoldersSkeleton() {
  return (
    <div aria-busy className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Skeleton key={i} className="h-24 w-full rounded-lg" />
      ))}
    </div>
  )
}

// The folders bring the catalogue's folder mark and item view with them: loaded when the Kunskap view is first opened.
const KnowledgeFolders = dynamic(() => import('@/components/skills/KnowledgeFolders').then((m) => m.KnowledgeFolders), { loading: () => <FoldersSkeleton /> })

/** What a row of the company's card opens: the rows are named where their addresses are (lib/agent-context/wiki-views.ts). */
export { PICTURE_ROWS as PICTURE_VIEWS, isPictureRow as isPictureView }
export type PictureView = PictureRow
type SheetView = Exclude<PictureView, 'context'>

/** An agent card as its panel shows it: the card, its name, and what the picture knows of its calls. */
export interface PictureAgentView {
  card: PictureAgentCard
  name: string
  /** The name is the company's own text (a hand-made key's, a service account's). */
  maskName: boolean
  /** The calls the card made today; null when it made none or the log could not be read. */
  calls: AgentPanelCalls | null
  activity: PictureActivity | null
}

/** What the side panel holds: a row's view, or an agent card. */
type Shown = { sheet: SheetView } | { agent: PictureAgentView }

/**
 * The briefing, as the page that hosts the picture loads it (once, when the
 * Kontext row is first opened): the context graph is drawn from its text.
 * `unavailable`: the installation has no briefing to read, said in the
 * server's own sentence.
 */
export type PictureContext =
  | { state: 'loading' }
  | { state: 'ok'; text: string }
  | { state: 'failed'; description: string; onRetry: () => void }
  | { state: 'unavailable'; sentence: string }

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
 * What is behind each row of the company's card. Every row opens its own
 * view, titled with the row's name, with a close control and nothing to
 * switch between: Kontext the context graph in the app's wide dialog with
 * the raw text under it, Kontroller the check lines, Minne the memory as one
 * list, Kunskap the knowledge items as folders, each opening in place. The
 * last three open in the app's slide-over, and so does what is behind an
 * agent card (`agent`, AgentPanel), titled with the card's name. A row and a
 * card are not open at once: with both given, the row shows.
 *
 * `knowledgeItem` is the knowledge item the address names: the Kunskap view
 * opens on its folder, and `onKnowledgeItemClose` is told when that folder
 * is left.
 */
export function PictureViews({
  view,
  agent = null,
  onClose,
  companyName,
  context,
  checks,
  activeKnowledge,
  knowledgeItem = null,
  onKnowledgeItemClose,
  when,
  time,
}: {
  view: PictureView | null
  /** The agent card that is open; null when none is. */
  agent?: PictureAgentView | null
  onClose: () => void
  companyName: string | null
  context: PictureContext
  checks: PictureChecks | null
  /** The knowledge items the agent gets today, by id; null when that could not be read. */
  activeKnowledge: readonly string[] | null
  knowledgeItem?: string | null
  onKnowledgeItemClose?: () => void
  /** An instant or a date in words: today (with its time), another day by its date. */
  when: (instant: string) => string
  /** The time of day of an instant. */
  time: PictureWords['time']
}) {
  const t = useTranslations('wiki')
  const sheet: SheetView | null = view && view !== 'context' ? view : null
  const current: Shown | null = sheet ? { sheet } : view === null && agent ? { agent } : null
  // The slide-over keeps its content while it slides away.
  const [last, setLast] = useState<Shown | null>(current)
  if (current && !sameShown(current, last)) setLast(current)
  const shown = current ?? last

  return (
    <>
      <Dialog open={view === 'context'} onOpenChange={(open) => !open && onClose()}>
        <DialogContent size="document" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('picture.row_context')}</DialogTitle>
          </DialogHeader>
          {context.state === 'ok' ? (
            <>
              {/* The graph bleeds to the page's edges on its own page; here the dialog's inset holds it. */}
              <ContextGraph text={context.text} className="mx-0 md:mx-0" />
              <RawText text={context.text} subject="company" />
            </>
          ) : context.state === 'failed' ? (
            <LoadError title={t('load_failed_title')} description={context.description} onRetry={context.onRetry} />
          ) : context.state === 'unavailable' ? (
            <EmptyState title={context.sentence} />
          ) : (
            <div aria-busy>
              <Skeleton className="h-80 w-full rounded-lg" />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <SlideOver open={current !== null} onOpenChange={(open) => !open && onClose()}>
        <SlideOverContent className="w-[560px]" aria-describedby={undefined}>
          {shown && 'sheet' in shown && (
            <>
              <SlideOverHeader kicker={companyName ? <span data-ph-mask="">{companyName}</span> : undefined} title={t(`picture.row_${shown.sheet}`)} />
              <SlideOverBody className="space-y-5">
                {shown.sheet === 'checks' && <ChecksView checks={checks} when={when} />}
                {shown.sheet === 'memory' && <AgentMemoryPanel plain />}
                {shown.sheet === 'knowledge' && <KnowledgeFolders active={activeKnowledge} item={knowledgeItem} onItemClose={onKnowledgeItemClose} />}
              </SlideOverBody>
            </>
          )}
          {shown && 'agent' in shown && (
            <>
              <SlideOverHeader
                kicker={companyName ? <span data-ph-mask="">{companyName}</span> : undefined}
                title={shown.agent.maskName ? <span data-ph-mask="">{shown.agent.name}</span> : shown.agent.name}
              />
              <SlideOverBody className="space-y-5">
                {/* One read per card: another card's panel starts over. */}
                <AgentPanel key={shown.agent.card.id} card={shown.agent.card} calls={shown.agent.calls} activity={shown.agent.activity} words={{ when, time }} />
              </SlideOverBody>
            </>
          )}
        </SlideOverContent>
      </SlideOver>
    </>
  )
}

/** Whether the panel already holds this: the same row's view, or the card as it was last given. */
function sameShown(a: Shown, b: Shown | null): boolean {
  if (!b) return false
  if ('sheet' in a) return 'sheet' in b && a.sheet === b.sheet
  return 'agent' in b && a.agent === b.agent
}

function ChecksView({ checks, when }: { checks: PictureChecks | null; when: (instant: string) => string }) {
  const t = useTranslations('wiki')
  if (!checks) return <div className="text-[13px] text-foreground/80">{t('picture.checks_unreadable')}</div>
  return (
    <>
      <div className="text-[13px] text-foreground/80">{t('picture.checks_intro')}</div>
      <ul>
        {/* A check that does not apply to the company is listed last, with its reason. */}
        {orderedCheckLines(checks.lines).map((line) => (
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
  // An account is named by its masked number as well, so two accounts with one name read apart.
  const subject = line.subject ? [line.subject, line.subject_tail ? `••${line.subject_tail}` : null].filter(Boolean).join(' ') : null
  const at = line.as_of ? when(line.as_of) : ''

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
        {/* A check that does not apply is said in the secondary ink: it is an answer, not something to do. */}
        <div className={cn('break-words text-[13px]', checkDoesNotApply(line) ? 'text-foreground/80' : 'text-strong')}>
          {name}
          {subject ? <span data-ph-mask="">{`: ${subject}`}</span> : null}
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
