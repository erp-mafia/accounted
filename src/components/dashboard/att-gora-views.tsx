'use client'

import { useCallback, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { createPortal } from 'react-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { EmptyState } from '@/components/ui/empty-state'
import { PAGE_BOTTOM_BAR_PROPS } from '@/components/ui/fab-clearance'
import { ChevronLeftIcon, ChevronRightIcon, CheckIcon, MagnifyingGlassIcon } from '@/components/icons'
import { CountTile } from '@/components/ui/count-tile'
import { cn, formatAmount, formatCurrency, formatDate } from '@/lib/utils'
import { useClockValue } from '@/lib/hooks/use-clock-value'
import { openCommandPalette } from '@/components/common/open-command-palette'
import { HEM_ACTION_SLOT_ID } from './hem-slot'
import { HemPrimaryTaken, StepSummarySink } from './need-count'
import {
  countThings,
  countUrgentThings,
  dueStateOf,
  firstRows,
  groupRows,
  headlineOf,
  queueWindow,
  shownRows,
  thingsOf,
  type NeedGroup,
  type NeedRowFacts,
} from './need-model'

/**
 * Att göra V8 ("calm Hem"): the two faces of the same rows. Hem lists them
 * under its headline (Först, then Behöver dig by group), Börja walks them one
 * at a time on the fixed step template. A row leads to the same place on
 * both lists. The rows, their state and their dialogs live in
 * AttGoraSection; everything here only draws.
 */

export type HemView = 'hem' | 'borja'

const hemHref = (view: HemView | 'gjort', step?: string) =>
  view === 'hem' ? '/' : `/?vy=${view}${step ? `&steg=${encodeURIComponent(step)}` : ''}`

export interface NeedRow extends NeedRowFacts {
  icon: ComponentType<{ className?: string }>
  /** The row as the list says it. */
  label: string
  /** The step's heading where the list's label repeats what the step shows beside it (the amount). */
  stepTitle?: string
  /** Data for the row (amounts, dates, who), after the label on the same line. */
  detail?: string
  /** What the row means: the label's hover text, and the step's reason line when present. */
  hint?: string
  /** Where the work is done. */
  href: string
  /** How many things the row stands for, where it is a count. */
  count?: number
  amount?: { value: number; currency?: string | null }
  /** An exception chip the row's own data sets (days left, stopped). */
  badge?: ReactNode
  /** The row's own action, done in place (a dialog): the list's row button and the step's primary. */
  act?: { label: string; run: () => void }
  /** Open the row's work in place instead of following the link. */
  onSelect?: () => void
  /** A second control beside the row (the Kvittojakten button). */
  extra?: ReactNode
  /** The step's typed fields. */
  facts?: Array<{ label: string; value: string }>
  /** A block that carries its own controls (a Förslag card, the rule postings): drawn in place of a plain row. */
  embed?: ReactNode
  /** The step's underlag and anything else the step loads for this row. */
  stepBody?: ReactNode
  /**
   * A step that is many things: what its primary says (action, object and
   * count, "Granska 7 underlag") and, when the target has a one-at-a-time
   * flow of its own, the address that opens it at the first item.
   */
  stepGo?: { label: string; href?: string }
  /** What the earliest date of the step's items is called among its fields ("Äldsta", "Förfaller"). */
  stepEarliestLabel?: string
  /** The step's primary when it is not the link or `act`: label, run, and whether it is running. */
  stepAct?: { label: string; run: () => void; loading?: boolean }
}

type T = ReturnType<typeof useTranslations>

/** The weekday line, "torsdag 5 november" or "Thursday 5 November", read in the viewer's time zone. */
function weekdayLine(now: Date, timeZone: string | undefined, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'sv-SE', { weekday: 'long', day: 'numeric', month: 'long', timeZone }).format(now)
}

export function amountText(amount: NeedRow['amount']): string {
  if (!amount) return ''
  // Rows carry no "kr" (it stays on headlines and dialogs); another currency keeps its mark.
  const text = formatCurrency(amount.value, amount.currency ?? undefined)
  return /kr$/.test(text) ? formatAmount(amount.value) : text
}

/** When a row falls due: a chip while it is urgent (the exception), else the date. */
function WhenCell({ row, todayIso, t, chipOnly = false }: { row: NeedRowFacts & { badge?: ReactNode }; todayIso: string; t: T; chipOnly?: boolean }) {
  if (row.badge) return <>{row.badge}</>
  const state = dueStateOf(row.due, todayIso)
  if (state === null) return null
  // A step says its date among its fields: only the exception is repeated at its head.
  if (state === 'later' && chipOnly) return null
  if (state === 'later') return <span className="date-figures text-xs text-muted-foreground">{formatDate(row.due as string)}</span>
  return (
    <Badge variant="warning" className="font-normal">
      {t(state === 'overdue' ? 'when_overdue' : state === 'today' ? 'when_today' : 'when_tomorrow')}
    </Badge>
  )
}

/** Puts the page's one primary into the top bar, once the bar is in the document. */
const noSubscription = () => () => {}

function TopBarAction({ children }: { children: ReactNode }) {
  // False on the server and while hydrating, true after: the slot is in the document by then.
  const mounted = useSyncExternalStore(noSubscription, () => true, () => false)
  const slot = mounted ? document.getElementById(HEM_ACTION_SLOT_ID) : null
  return slot ? createPortal(children, slot) : null
}

/**
 * The primary names what it starts: "Börja med {name}" when the first row is
 * one named thing, else "Börja med N saker", the number the headline, the
 * sidebar and "Visa alla N som lista" show.
 */
function startLabel(rows: NeedRow[], t: T): string {
  const first = rows[0]
  // Named: the row has a name of its own (a supplier, a person, a document), not its label standing in for one.
  if (first.name !== first.label && !first.embed) return t('start_with', { name: first.name })
  const things = countThings(rows)
  return things > 0 ? t('start_count', { count: things }) : t('start')
}

/** Where the page's primary goes and what it says: Börja at the first row, else the way to a first row. */
export interface LeadAction {
  label: string
  href: string
}

function leadOf(rows: NeedRow[], fallback: LeadAction | null | undefined, t: T): LeadAction | null {
  if (rows.length > 0) return { label: startLabel(rows, t), href: hemHref('borja', rows[0].key) }
  return fallback ?? null
}

/** The page's one primary: in the top bar on a wide screen, a full-width button in the page on a phone. */
function StartButton({ lead }: { lead: LeadAction | null }) {
  if (!lead) return null
  return (
    <TopBarAction>
      <Button size="toolbar" asChild className="hidden md:inline-flex">
        <Link href={lead.href}>
          {/* data-ph-mask: the name is a counterparty or a document title. */}
          <span className="max-w-[40ch] truncate" data-ph-mask="">
            {lead.label}
          </span>
        </Link>
      </Button>
    </TopBarAction>
  )
}

function PhoneStartButton({ lead }: { lead: LeadAction | null }) {
  if (!lead) return null
  return (
    <Button size="lg" asChild className="w-full md:hidden">
      <Link href={lead.href}>
        <span className="min-w-0 truncate" data-ph-mask="">
          {lead.label}
        </span>
      </Link>
    </Button>
  )
}

const SECTION_TITLE_CLASS = 'text-[15px] font-medium text-strong'

/* ------------------------------------------------------------------ Hem */

export function HemCalm({
  rows,
  todayIso,
  pendingCount,
  clearBody,
  notStarted = false,
  lead,
  facts,
  afterHeadline,
  resume,
  connections,
  incomplete = false,
}: {
  rows: NeedRow[]
  todayIso: string
  /** The company has not got going (nothing booked, nothing on its way): an empty list is then not "all done". */
  notStarted?: boolean
  /**
   * A count could not be read and answered zero (WorklistCounts.incomplete):
   * an empty list is then never "Allt är klart", and the page says that
   * something may be missing, with a way to read it again.
   */
  incomplete?: boolean
  /** The primary while nothing waits and the company has not got going: the way to a first row. */
  lead?: LeadAction | null
  /** Proposals waiting in Rutin. */
  pendingCount: number
  /** What the all-clear state says under the headline (the product's own empty-state lines). */
  clearBody: ReactNode
  /** The glance line under the headline (next deadline). */
  facts?: ReactNode
  /** Kom igång, for a company that still has it. */
  afterHeadline?: ReactNode
  resume?: ReactNode
  connections?: ReactNode
}) {
  const t = useTranslations('hem')
  const tCommon = useTranslations('common')
  const tPending = useTranslations('pending')
  const router = useRouter()
  const { canWrite, lockedTitle } = useViewerLock()
  const locale = useLocale()
  const dateLine = useClockValue((now, timeZone) => weekdayLine(now, timeZone, locale))
  // The headline counts things, not rows: "Betala 5 leverantörsfakturor" is five.
  const headline = headlineOf(countUrgentThings(rows, todayIso), countThings(rows), !notStarted)
  const first = firstRows(rows, todayIso)
  // A row in Först is not listed again below it.
  const firstKeys = new Set(first.map((row) => row.key))
  const listed = rows.filter((row) => !firstKeys.has(row.key))
  const primary = leadOf(rows, lead, t)
  // Kom igång leads the page until something is
  // urgent; then the three blocks (Först, Behöver dig, Rutin) come first and
  // it follows.
  const setup = afterHeadline ? <HemPrimaryTaken.Provider value={primary !== null}>{afterHeadline}</HemPrimaryTaken.Provider> : null
  const urgentFirst = headline.urgent > 0 && first.length > 0

  return (
    <div className="stagger-enter space-y-8">
      <StartButton lead={primary} />
      <section>
        <p className="text-xs font-medium text-muted-foreground">{dateLine.charAt(0).toLocaleUpperCase('sv-SE') + dateLine.slice(1)}</p>
        {/* The one 20px heading: a template with counts, never a sentence about
            one item. The top bar holds the page's h1, so this is an h2; the
            live region is around it, not on it (a role would unseat the heading). */}
        <div role="status" aria-live="polite">
          <h2 className="mt-1.5 text-xl text-strong">
            {headline.kind === 'clear'
              ? t(incomplete ? 'headline_incomplete' : 'headline_clear')
              : headline.kind === 'not_started'
                ? t('headline_not_started')
                : headline.kind === 'waiting'
                  ? t('headline_waiting', { count: headline.total })
                  : headline.kind === 'urgent_only'
                    ? t('headline_urgent_only', { urgent: headline.urgent })
                    : t('headline_urgent', { urgent: headline.urgent, rest: headline.rest })}
          </h2>
        </div>
        {facts}
        {incomplete ? (
          <div className="mt-1.5 flex max-w-[560px] flex-wrap items-baseline gap-x-2 text-[13px] text-muted-foreground">
            <span>{t('incomplete_body')}</span>
            <button type="button" className="text-foreground underline underline-offset-[3px]" onClick={() => router.refresh()}>
              {tCommon('retry')}
            </button>
          </div>
        ) : (
          (headline.kind === 'clear' || headline.kind === 'not_started') && clearBody && <div className="mt-1.5 max-w-[560px] text-[13px] text-muted-foreground">{clearBody}</div>
        )}
        {primary && (
          <div className="mt-4 md:hidden">
            <PhoneStartButton lead={primary} />
          </div>
        )}
      </section>

      {!urgentFirst && setup}

      {first.length > 0 && (
        <section aria-label={t('first_title')}>
          <h2 className={SECTION_TITLE_CLASS}>{t('first_title')}</h2>
          <ul className="-mx-2 mt-2 border-t-hairline">
            {first.map((row) =>
              row.embed ? <li key={row.key} className="px-1">{row.embed}</li> : <ListRow key={row.key} row={row} todayIso={todayIso} t={t} />,
            )}
          </ul>
        </section>
      )}

      {listed.length > 0 && (
        <section aria-label={t('need_title')}>
          <h2 className={SECTION_TITLE_CLASS}>{t('need_title')}</h2>
          <NeedGroups rows={listed} todayIso={todayIso} t={t} />
        </section>
      )}

      {pendingCount > 0 && (
        <section aria-label={t('rutin_title')}>
          <h2 className={SECTION_TITLE_CLASS}>{t('rutin_title')}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1 basis-64 text-[13px]">{tPending('rutin_headline', { count: pendingCount })}</p>
            <span className="flex flex-wrap gap-2">
              <Button variant="ghost" asChild>
                <Link href="/pending">{t('rutin_show_all')}</Link>
              </Button>
              {/* A read-only member reads the queue ("Visa alla"); approving is locked. */}
              {canWrite ? (
                <Button variant="outline" asChild>
                  <Link href="/pending?vy=stickprov">{tPending('approve_proposals_open')}</Link>
                </Button>
              ) : (
                <Button variant="outline" disabled title={lockedTitle}>
                  {tPending('approve_proposals_open')}
                </Button>
              )}
            </span>
          </div>
        </section>
      )}

      {urgentFirst && setup}

      {resume}

      <AskField label={t('ask_placeholder')} />

      {connections}

      <nav className="flex flex-wrap gap-x-5 gap-y-1" aria-label={t('foot_label')}>
        <Link
          href={hemHref('gjort')}
          className="inline-flex min-h-7 items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-strong pointer-coarse:min-h-10"
        >
          {t('foot_done')}
          <ChevronRightIcon className="h-3 w-3" />
        </Link>
      </nav>
    </div>
  )
}

/**
 * One field for "what do you want to do": it opens the command palette, which
 * derives its entries (pages, actions, records) with the company's own gates.
 */
function AskField({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className="flex h-9 w-full max-w-[560px] items-center gap-2.5 rounded-lg bg-control px-3 text-left text-[13px] text-muted-foreground shadow-raised pointer-coarse:h-10 transition-shadow duration-150 hover:shadow-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
    >
      <MagnifyingGlassIcon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  )
}

/* ---------------------------------------------------------- Behöver dig */

function ListRow({ row, todayIso, t }: { row: NeedRow; todayIso: string; t: T }) {
  const { canWrite, lockedTitle } = useViewerLock()
  // The label is the link, stretched over the row, so the row's own button
  // can sit beside it instead of inside an anchor.
  return (
    <li className="group relative flex min-h-11 w-full items-center gap-3 border-b-hairline px-2 py-2 transition-colors duration-150 hover:bg-secondary/35">
      <span className="w-[18px] shrink-0 text-muted-foreground" aria-hidden>
        <row.icon className="h-[15px] w-[15px]" />
      </span>
      <p className="flex min-w-0 flex-1 items-center gap-2 text-[13px]" data-ph-mask="">
        <span className="min-w-0 truncate">
          <Link
            href={row.href}
            title={row.hint}
            onClick={
              row.onSelect
                ? (e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                    e.preventDefault()
                    row.onSelect?.()
                  }
                : undefined
            }
            className="text-strong after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/70"
          >
            {row.label}
          </Link>
          {row.detail && <span className="text-muted-foreground"> · {row.detail}</span>}
        </span>
        {/* How many the row stands for sits with its label: the amount column holds money only. */}
        {row.count !== undefined && <CountTile value={row.count.toLocaleString('sv-SE')} className="shrink-0" />}
      </p>
      {(row.extra || row.act) && (
        <span className="relative z-10 flex shrink-0 items-center gap-2">
          {row.extra}
          {row.act && (
            <Button variant="outline" onClick={row.act.run} disabled={!canWrite} title={lockedTitle}>
              {row.act.label}
            </Button>
          )}
        </span>
      )}
      <span className="flex shrink-0 justify-start empty:hidden sm:w-24 sm:empty:flex">
        <WhenCell row={row} todayIso={todayIso} t={t} />
      </span>
      <span className="shrink-0 text-right text-[13px] tabular-nums empty:hidden sm:w-24 sm:empty:block">{row.amount ? amountText(row.amount) : null}</span>
      <ChevronRightIcon className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 sm:block" />
    </li>
  )
}

/**
 * The rows by group, as Hem lists them: a verb heading per group (with its
 * sum where there are several rows), the rows, and "Visa alla N" on a long
 * group so the list stays one screen per group. Anchored by group (#decide,
 * #review) for the links that lead to one.
 */
function NeedGroups({ rows, todayIso, t }: { rows: NeedRow[]; todayIso: string; t: T }) {
  const groups = groupRows(rows)
  const [openGroups, setOpenGroups] = useState<ReadonlySet<NeedGroup>>(new Set())
  return (
    <div className="-mx-2 mt-2">
      <div className="hidden h-8 items-center gap-3 border-b-hairline px-2 text-xs font-medium text-muted-foreground sm:flex" aria-hidden>
        <span className="min-w-0 flex-1">{t('col_what')}</span>
        <span className="w-24 shrink-0">{t('col_when')}</span>
        <span className="w-24 shrink-0 text-right">{t('col_amount')}</span>
        <span className="hidden w-3.5 shrink-0 sm:block" />
      </div>
      {groups.map(({ group, rows: groupRowsOf }) => {
        const { shown, hidden } = shownRows(groupRowsOf, openGroups.has(group))
        const headId = `need-group-${group}`
        return (
          <section key={group} id={group} aria-labelledby={headId}>
            <h3 id={headId} className="flex items-end gap-2 border-b-hairline px-2 pb-1.5 pt-4 text-xs font-medium text-muted-foreground">
              {t(`verb_${group}`)}
              {/* The sum, where there are several rows to sum; one row says its own number. */}
              {groupRowsOf.length > 1 && <span className="font-normal tabular-nums">{Math.max(1, countThings(groupRowsOf))}</span>}
            </h3>
            <ul>
              {shown.map((row) =>
                row.embed ? <li key={row.key} className="px-1">{row.embed}</li> : <ListRow key={row.key} row={row} todayIso={todayIso} t={t} />,
              )}
            </ul>
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setOpenGroups((prev) => new Set(prev).add(group))}
                className="flex min-h-11 w-full items-center border-b-hairline px-2 text-left text-xs text-foreground underline underline-offset-[3px] transition-colors duration-150 hover:bg-secondary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
              >
                {t('list_show_all', { count: groupRowsOf.length })}
              </button>
            )}
          </section>
        )
      })}
    </div>
  )
}

/* ----------------------------------------------------------------- Börja */

export function GuidedSteps({
  rows,
  todayIso,
  stepKey,
  onStep,
  notStarted = false,
}: {
  rows: NeedRow[]
  todayIso: string
  /** See HemCalm.notStarted. */
  notStarted?: boolean
  /** The step on screen; null once the walk is through. */
  stepKey: string | null
  onStep: (key: string | null) => void
}) {
  const t = useTranslations('hem')
  const { canWrite, lockedTitle } = useViewerLock()
  const index = stepKey ? rows.findIndex((row) => row.key === stepKey) : -1
  const row = index === -1 ? null : rows[index]
  const next = index === -1 ? null : (rows[index + 1]?.key ?? null)
  const previous = index > 0 ? rows[index - 1].key : null
  // What the step's table read (StepItems): kept with the step it belongs to.
  const [summary, setSummary] = useState<{ key: string; earliest: string | null; sum: { value: number; currency: string | null } | null } | null>(null)
  const rowKey = row?.key ?? null
  const tellStep = useCallback(
    (read: { earliest: string | null; sum: { value: number; currency: string | null } | null }) => {
      if (rowKey) setSummary((prev) => (prev && prev.key === rowKey && prev.earliest === read.earliest && prev.sum?.value === read.sum?.value ? prev : { key: rowKey, ...read }))
    },
    [rowKey],
  )
  const read = summary && summary.key === rowKey ? summary : null

  if (!row) {
    // Through the walk with rows still standing is not "done": no green check,
    // the number that is left (the one Hem shows) and the way back to it.
    const left = countThings(rows)
    if (rows.length > 0) {
      return (
        <EmptyState
          title={t('borja_done_title')}
          description={left > 0 ? t('borja_done_body', { count: left }) : undefined}
          actionLabel={t('back_home')}
          actionHref={hemHref('hem')}
        />
      )
    }
    return (
      <EmptyState
        tone={notStarted ? 'empty' : 'done'}
        icon={notStarted ? undefined : CheckIcon}
        title={t(notStarted ? 'headline_not_started' : 'headline_clear')}
        actionLabel={t('back_home')}
        actionHref="/"
      />
    )
  }

  const groups = groupRows(rows)
  const primary = row.stepAct ?? row.act ?? (row.onSelect ? { label: row.stepGo?.label ?? t(`verb_${row.group}`), run: row.onSelect } : null)

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 md:min-h-[calc(100dvh-7.25rem)] lg:grid-cols-[220px_minmax(0,1fr)]">

      {/* The queue: where you are and what comes next. Beside the step on a
          wide screen, where it stays in view and scrolls by itself; left out
          on a narrow one (the bar below counts and steps back). */}
      <nav className="-mx-2 hidden self-start lg:sticky lg:top-14 lg:block lg:max-h-[calc(100dvh-10rem)] lg:overflow-y-auto" aria-label={t('queue_title')}>
        <p className="flex h-7 items-center px-2 text-xs font-medium text-muted-foreground">{t('queue_title')}</p>
        {groups.map(({ group, rows: groupRowsOf }) => {
          const { shown, before, after } = queueWindow(groupRowsOf, groupRowsOf.indexOf(row))
          // Two rows with one name (two invoices from one supplier) are told apart by their amount.
          const names = groupRowsOf.map((item) => item.name)
          return (
            <div key={group}>
              <p className="flex h-6 items-end px-2 pb-0.5 text-xs text-muted-foreground">{t(`verb_${group}`)}</p>
              {before > 0 && <p className="flex h-6 items-center px-2 text-xs text-muted-foreground">{t('queue_more', { count: before })}</p>}
              {shown.map((item) => {
                const on = item.key === row.key
                const twin = item.amount && names.indexOf(item.name) !== names.lastIndexOf(item.name)
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-current={on ? 'step' : undefined}
                    onClick={() => onStep(item.key)}
                    className={cn(
                      'flex min-h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70',
                      on ? 'bg-secondary font-medium text-strong' : 'hover:bg-secondary/60',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate" data-ph-mask="">{item.name}</span>
                    {on ? (
                      <span className="shrink-0 text-xs font-normal text-muted-foreground">{t('queue_now')}</span>
                    ) : twin ? (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-ph-mask="">{amountText(item.amount)}</span>
                    ) : null}
                  </button>
                )
              })}
              {after > 0 && <p className="flex h-6 items-center px-2 text-xs text-muted-foreground">{t('queue_more', { count: after })}</p>}
            </div>
          )
        })}
      </nav>

      <div className="flex min-w-0 flex-col max-md:pb-20">
        {/* Head: who and what, the amount, when. */}
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
          <div className="min-w-0 flex-1 basis-64">
            <h2 className="break-words text-xl text-strong" data-ph-mask="">{row.stepTitle ?? row.label}</h2>
            {row.detail && <p className="mt-0.5 break-words text-[13px] text-muted-foreground" data-ph-mask="">{row.detail}</p>}
          </div>
          <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
            {row.amount && (
              <p className="font-display text-2xl tabular-nums text-strong">{formatCurrency(row.amount.value, row.amount.currency ?? undefined)}</p>
            )}
            <WhenCell row={row} todayIso={todayIso} t={t} chipOnly />
          </div>
        </div>

        {row.embed ? (
          <div className="mt-5">{row.embed}</div>
        ) : (
          // A file sits beside its fields on a wide screen. A table of items (a step
          // that is many things) takes the width, with the fields under it.
          <div className={cn('mt-5 grid grid-cols-[minmax(0,1fr)] items-start gap-6', row.stepBody && !row.stepGo && 'xl:grid-cols-[minmax(0,1fr)_minmax(260px,320px)] xl:gap-x-10')}>
            {row.stepBody && (
              // No label over it: the file viewer and the table carry their own heads.
              <div className="min-w-0">
                <StepSummarySink.Provider value={tellStep}>{row.stepBody}</StepSummarySink.Provider>
              </div>
            )}
            <div className="min-w-0 max-w-[760px]">
              <h3 className={SECTION_TITLE_CLASS}>{t('step_fields')}</h3>
              <dl className="mt-2 border-t-hairline text-[13px]">
                {(row.facts ?? []).map((fact) => (
                  <div key={fact.label} className="flex min-h-9 items-center gap-4 border-b-hairline py-2">
                    <dt className="shrink-0 text-strong">{fact.label}</dt>
                    <dd className="min-w-0 flex-1 break-words text-right tabular-nums" data-ph-mask="">{fact.value}</dd>
                  </div>
                ))}
                {/* The count is in the heading where the heading says it ("7 underlag"). */}
                {row.count !== undefined && !row.stepTitle && (
                  <div className="flex min-h-9 items-center gap-4 border-b-hairline py-2">
                    <dt className="shrink-0 text-strong">{t('fact_count')}</dt>
                    <dd className="min-w-0 flex-1 text-right tabular-nums">{row.count.toLocaleString('sv-SE')}</dd>
                  </div>
                )}
                {/* From the step's own items: the earliest date, and their sum when all of them are listed. */}
                {row.stepEarliestLabel && read?.earliest && (
                  <div className="flex min-h-9 items-center gap-4 border-b-hairline py-2">
                    <dt className="shrink-0 text-strong">{row.stepEarliestLabel}</dt>
                    <dd className="date-figures min-w-0 flex-1 text-right">{formatDate(read.earliest)}</dd>
                  </div>
                )}
                {row.stepEarliestLabel && read?.sum && (
                  <div className="flex min-h-9 items-center gap-4 border-b-hairline py-2">
                    <dt className="shrink-0 text-strong">{t('fact_sum')}</dt>
                    <dd className="min-w-0 flex-1 text-right tabular-nums">{formatCurrency(read.sum.value, read.sum.currency ?? undefined)}</dd>
                  </div>
                )}
                {/* One reason line, from a closed list: the row's own explanation, else its group's. */}
                <div className="flex min-h-9 items-center gap-4 border-b-hairline py-2">
                  <dt className="shrink-0 text-strong">{t('step_why')}</dt>
                  <dd className="min-w-0 flex-1 break-words text-right">{row.hint ?? t(`why_${row.group}`)}</dd>
                </div>
              </dl>
            </div>
          </div>
        )}

        {/* The step's bar, fixed to the bottom of the panel (above the bottom
            nav on a phone): the progress and Hoppa över on the left, the
            step's one primary last. Sticky at the panel's own edge: at -2rem
            a step taller than the panel had its bar 32px under the edge. */}
        <div
          {...PAGE_BOTTOM_BAR_PROPS}
          className="z-10 mt-auto flex flex-wrap items-center gap-2 border-t-hairline bg-background py-3 max-md:fixed max-md:inset-x-0 max-md:bottom-[var(--bottom-nav-h)] max-md:px-4 md:sticky md:bottom-0 md:-mb-8"
        >
          {/* Without the queue beside it, the bar is also the way back one step. */}
          {previous && (
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t('borja_previous')} onClick={() => onStep(previous)}>
              <ChevronLeftIcon className="h-4 w-4" />
            </Button>
          )}
          <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground" aria-live="polite">
            {t('borja_progress', { index: index + 1, count: rows.length })}
          </span>
          <Button variant="ghost" onClick={() => onStep(next)}>
            {t('borja_skip')}
          </Button>
          <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {row.extra}
            {!row.embed &&
              (primary ? (
                <>
                  <Button variant="ghost" asChild>
                    <Link href={row.href}>{t('step_open')}</Link>
                  </Button>
                  <Button onClick={primary.run} loading={row.stepAct?.loading} disabled={!canWrite} title={lockedTitle}>
                    {primary.label}
                  </Button>
                </>
              ) : (
                <Button asChild>
                  {/* A step that is many things leaves for their list and says so; one thing is done where its verb leads. */}
                  <Link href={row.stepGo?.href ?? row.href}>
                    {row.stepGo?.label ?? (row.count !== undefined || thingsOf(row) > 1 ? t('step_open_list') : t(`verb_${row.group}`))}
                  </Link>
                </Button>
              ))}
          </span>
        </div>
      </div>
    </div>
  )
}
