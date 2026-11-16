'use client'

// The review of ONE proposal on its fixed template (Att göra V8, KIT rules
// D1 and D2): head, underlag, the proposal as typed fields and the verifikat
// it posts, one reason line, the history behind a disclosure, and the
// actions in a fixed footer. The parts are the same in the Rutin drawer and
// on the full page (/pending/[id]); only their arrangement differs. Nothing
// here approves or rejects: the page that owns the queue passes its handlers.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { AttnLine } from '@/components/ui/attn-line'
import { EmptyState } from '@/components/ui/empty-state'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { PAGE_BOTTOM_BAR_PROPS } from '@/components/ui/fab-clearance'
import { CheckIcon, ChevronRightIcon, DocumentTextIcon } from '@/components/icons'
import { cn, formatAmount, formatCurrency, formatDate, formatDateLong } from '@/lib/utils'
import { isUuid } from '@/lib/invariants/uuid'
import type { PendingOperation } from '@/types'
import { OperationPreview, useComplianceWarningText } from './OperationPreview'
import { ProposalDocument } from './ProposalDocument'
import type { ProposalDocumentRef } from './proposal-document'
import { Fact, FactList, MissingLabelsContext, MissingMark, PreviewDensityContext, ReviewTitleContext, factLabelText } from './preview-parts'
import {
  headlineAmount,
  missingFields,
  proposalFacts,
  reviewHistory,
  reviewReason,
  stagedPostingLines,
  underlagOf,
  type HistoryEvent,
  type StepPosition,
} from './review-model'
import { rejectionCategoryLabel } from './vocabulary'

const SECTION_TITLE_CLASS = 'text-[15px] font-medium text-strong'
const SLOT_LABEL_CLASS = 'mb-1 text-xs font-medium text-muted-foreground'

/* -------------------------------------------------------------------- head */

/** The headline number, where the proposal names an amount. Hedvig, as every headline number. */
export function ReviewAmount({ op, className }: { op: PendingOperation; className?: string }) {
  const amount = headlineAmount(op)
  if (!amount) return null
  return (
    <p className={cn('font-display text-2xl tabular-nums text-strong', className)} data-ph-mask="">
      {amount.currency ? formatCurrency(amount.value, amount.currency) : formatAmount(amount.value)}
    </p>
  )
}

/** The risk chip, an exception only: low risk is the normal case and says nothing. */
export function ReviewRisk({ op, quiet = false }: { op: PendingOperation; quiet?: boolean }) {
  const t = useTranslations('pending')
  if (op.risk_level === 'low') return null
  // In a list most rows are medium risk: there it reads as muted text, and
  // the chip is left for the rows that deviate (convention 5).
  if (quiet && op.risk_level !== 'high') {
    return <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{t('badge_medium_risk')}</span>
  }
  return (
    <Badge variant={op.risk_level === 'high' ? 'destructive' : 'outline'} className="shrink-0 font-normal">
      {op.risk_level === 'high' ? t('badge_high_risk') : t('badge_medium_risk')}
    </Badge>
  )
}

/* ---------------------------------------------------------------- underlag */

/**
 * The underlag of the bank row a categorisation acts on: the document pinned
 * to the row or matched to it from the inbox (GET
 * /api/transactions/[id]/underlag, the read the booking review uses). Tagged
 * with the row it was read for, so a slow answer for the previous proposal
 * never shows under the next one.
 */
function useTransactionUnderlag(transactionId: string | null) {
  const [fetched, setFetched] = useState<{ id: string; document: ProposalDocumentRef | null; failed: boolean } | null>(null)
  useEffect(() => {
    if (!transactionId) return
    let cancelled = false
    fetch(`/api/transactions/${transactionId}/underlag`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { data?: { document?: { id?: unknown; file_name?: unknown; mime_type?: unknown } | null } }) => {
        if (cancelled) return
        const doc = body.data?.document
        setFetched({
          id: transactionId,
          failed: false,
          document:
            doc && isUuid(doc.id)
              ? {
                  kind: 'document',
                  documentId: doc.id,
                  fileName: typeof doc.file_name === 'string' ? doc.file_name : null,
                  mime: typeof doc.mime_type === 'string' ? doc.mime_type : null,
                }
              : null,
        })
      })
      .catch(() => {
        if (!cancelled) setFetched({ id: transactionId, document: null, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [transactionId])
  const current = fetched?.id === transactionId ? fetched : null
  return { loading: transactionId != null && current == null, document: current?.document ?? null, failed: current?.failed ?? false }
}

/**
 * The underlag slot: the real file shown as the file, the bank row the
 * proposal acts on, or the plain state that there is none. Renders nothing
 * for a proposal with no underlag to speak of (a new customer).
 */
export function ReviewUnderlag({
  op,
  viewerClassName,
  slot = false,
}: {
  op: PendingOperation
  viewerClassName: string
  /** The full-page template: the slot keeps its place for a proposal with no underlag, and says so. */
  slot?: boolean
}) {
  const t = useTranslations('pending')
  const tHem = useTranslations('hem')
  const underlag = underlagOf(op)
  const ofRow = useTransactionUnderlag(underlag?.transactionId ?? null)
  if (!underlag) {
    if (!slot) return null
    return (
      <section className="min-w-0" aria-label={t('preview_link_document_heading')}>
        <h3 className={SLOT_LABEL_CLASS}>{t('preview_link_document_heading')}</h3>
        <p className="border-y-hairline py-2 text-[13px] text-muted-foreground">{t('review_no_underlag')}</p>
      </section>
    )
  }
  const { bankRow } = underlag
  const document = underlag.document ?? ofRow.document
  // The staging tool said so (a verifikat), or the bank row has none.
  const missing = underlag.missing || (underlag.transactionId != null && !ofRow.loading && !ofRow.failed && !document)
  return (
    <section className="min-w-0 space-y-3" aria-label={t('preview_link_document_heading')}>
      <div>
        {/* The file's own header names it; the label heads the other states. */}
        {!document && <h3 className={SLOT_LABEL_CLASS}>{t('preview_link_document_heading')}</h3>}
        {document && <ProposalDocument docRef={document} detail viewerClassName={viewerClassName} />}
        {ofRow.loading && (
          <LateReveal>
            <Skeleton className={cn('w-full rounded-lg', slot ? viewerClassName : 'h-36')} />
          </LateReveal>
        )}
        {ofRow.failed && <p className="text-[13px] text-muted-foreground">{tHem('step_underlag_failed')}</p>}
        {missing && (
          <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-lg bg-muted px-4 py-6 text-center">
            <DocumentTextIcon className="h-5 w-5 text-muted-foreground" aria-hidden />
            <p className="text-[13px] text-strong">{tHem('why_upload')}</p>
          </div>
        )}
      </div>
      {bankRow && (
        <div className="flex min-h-11 items-center gap-4 border-y-hairline py-2 text-[13px]">
          <div className="min-w-0 flex-1">
            {/* data-ph-mask: the bank's text names a counterparty. */}
            <p className="break-words text-strong" data-ph-mask="">
              {[bankRow.date ? formatDate(bankRow.date) : null, bankRow.text].filter(Boolean).join(' · ')}
            </p>
            <p className="text-xs text-muted-foreground">{t('review_bank_row')}</p>
          </div>
          {bankRow.amount !== null && (
            <span className="shrink-0 tabular-nums text-strong" data-ph-mask="">
              {formatCurrency(bankRow.amount, bankRow.currency)}
            </span>
          )}
        </div>
      )}
    </section>
  )
}

/* ---------------------------------------------------------------- proposal */

/**
 * "Det här bokförs" for a proposal that posts a verifikat, "Förslaget" for
 * the rest: the preview's typed fields and voucher lines exactly as staged,
 * then what is missing, the audit note and the one reason line.
 */
export function ReviewProposal({ op }: { op: PendingOperation }) {
  const t = useTranslations('pending')
  const posts = stagedPostingLines(op.preview_data).length > 0
  const { reason, note } = reviewReason(op)
  const missing = missingFields(op).map((label) => factLabelText(label, t))
  // A missing field is marked where the preview states it; one the preview
  // has no row for (a verifikat without lines has no Konto) gets a row.
  const stated = new Set((proposalFacts(op.operation_type, op.preview_data) ?? []).flat().map((fact) => factLabelText(fact.label, t)))
  const unstated = missing.filter((label) => !stated.has(label))
  return (
    <section className="@container min-w-0" aria-label={t(posts ? 'review_posts_heading' : 'review_proposal_heading')}>
      <h3 className={SECTION_TITLE_CLASS}>{t(posts ? 'review_posts_heading' : 'review_proposal_heading')}</h3>
      <div className="mt-2">
        <MissingLabelsContext.Provider value={new Set(missing)}>
          <ReviewTitleContext.Provider value={op.title}>
            <OperationPreview op={op} detail template />
          </ReviewTitleContext.Provider>
        </MissingLabelsContext.Provider>
      </div>
      <PreviewDensityContext.Provider value="template">
        {(unstated.length > 0 || note || reason) && (
          // Under a verifikat the rows stand apart from its Summa; under
          // fields they continue the same list.
          <FactList className={posts ? 'mt-3' : 'border-t-0'}>
            {unstated.map((label) => (
              <Fact key={label} label={label}>
                <MissingMark />
              </Fact>
            ))}
            {/* The agent's audit-trail note (the `notes` tool input). */}
            {note && (
              <Fact label={t('note_label')} textLength={note.length}>
                <span className="whitespace-pre-wrap">{note}</span>
              </Fact>
            )}
            {/* One reason line, in the stager's own words: free text, may name people. */}
            {reason && (
              <Fact label={t('review_why')} textLength={reason.length}>
                <span className="whitespace-pre-wrap">{reason}</span>
              </Fact>
            )}
          </FactList>
        )}
      </PreviewDensityContext.Provider>
    </section>
  )
}

/** The staged warning as the review's one attention line. */
export function ReviewAttention({ op }: { op: PendingOperation }) {
  const warningText = useComplianceWarningText()
  const { attention } = reviewReason(op)
  if (!attention) return null
  return <AttnLine className="break-words">{warningText(attention)}</AttnLine>
}

/* ----------------------------------------------------------------- history */

/**
 * Who did what, closed until asked for: when the proposal was staged and by
 * whom, the instructions the agent retrieved, and how it was resolved.
 * `origin` is the page's attribution line ("Föreslaget av Claude åt Jonas
 * Ek"), `retrieved` its instruction names; `trailing` a quiet link that
 * belongs with the trail (the conversation the proposal came from).
 */
export function ReviewHistory({
  op,
  origin,
  retrieved,
  trailing,
}: {
  op: PendingOperation
  origin: string | null
  retrieved: string | null
  trailing?: ReactNode
}) {
  const t = useTranslations('pending')
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const events = reviewHistory(op)
  const when = (at: string | null) => (at ? formatDateLong(at, locale) : null)
  const line = (event: HistoryEvent): { text: string; sub: string | null } | null => {
    switch (event.kind) {
      case 'staged':
        return { text: origin ?? t('review_history_staged'), sub: when(event.at) }
      case 'instructions':
        return retrieved ? { text: t('skills_retrieved', { skills: retrieved }), sub: null } : null
      case 'approved':
        return { text: t('badge_approved'), sub: when(event.at) }
      case 'rejected':
        return {
          text: [
            t('badge_rejected'),
            event.category ? rejectionCategoryLabel(event.category) : null,
          ]
            .filter(Boolean)
            .join(': '),
          sub: [when(event.at), event.reason ? `"${event.reason}"` : null].filter(Boolean).join(' · ') || null,
        }
      case 'expired':
        return { text: t('badge_auto_expired'), sub: when(event.at) }
      case 'handled_elsewhere':
        return { text: t('badge_handled_elsewhere'), sub: when(event.at) }
      case 'closed_by_refusal':
        return { text: t('closed_by_refusal_detail', { reason: event.reason }), sub: when(event.at) }
      case 'failed_partial':
        return { text: t('badge_failed_partial'), sub: when(event.at) }
      case 'unknown':
        return { text: t('badge_unknown'), sub: when(event.at) }
    }
  }
  const rows = events.map(line).filter((row): row is { text: string; sub: string | null } => row !== null)
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-7 items-center gap-1 rounded-md text-xs text-muted-foreground transition-colors duration-150 hover:text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 pointer-coarse:min-h-10"
      >
        {t('review_history_show')}
        <ChevronRightIcon className={cn('h-3 w-3 transition-transform duration-150', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-1 border-t-hairline text-[13px]">
          {rows.map((row, index) => (
            <div key={index} className="border-b-hairline py-2" data-ph-mask="">
              <p className="break-words">{row.text}</p>
              {row.sub && <p className="break-words text-xs text-muted-foreground">{row.sub}</p>}
            </div>
          ))}
          {trailing && <div className="py-2">{trailing}</div>}
        </div>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- actions */

export interface ReviewPrimary {
  label: string
  onClick: () => void
  disabled?: boolean
  /** Why it is disabled (a locked period), as the button's hover text. */
  title?: string
}

/**
 * What the actions say before they are pressed: the consequence sentence the
 * approval consents to, or, when a required field is missing, which one. The
 * primary is then disabled; nothing else about approving changes.
 */
export function useReviewGate(op: PendingOperation | null, consequence: string) {
  const t = useTranslations('pending')
  const missing = op ? missingFields(op) : []
  const note =
    missing.length > 0
      ? t('review_missing_named', { fields: missing.map((label) => factLabelText(label, t)).join(', ') })
      : consequence
  return { blocked: missing.length > 0, note }
}

/** "Ser fel ut" (the reject dialog) and the one filled primary, in that order. */
export function ReviewActionButtons({
  primary,
  blocked,
  onReject,
  rejectDisabled,
  primaryShortcut,
}: {
  primary: ReviewPrimary
  blocked: boolean
  onReject: () => void
  rejectDisabled?: boolean
  /** The key that presses the primary on the full-page walk, announced to assistive technology. */
  primaryShortcut?: string
}) {
  const t = useTranslations('pending')
  // A read-only member reads the proposal and walks the queue; both verdicts are locked.
  const { canWrite, lockedTitle } = useViewerLock()
  return (
    <>
      <Button variant="ghost" onClick={onReject} disabled={!canWrite || rejectDisabled} title={lockedTitle}>
        {t('spot_looks_wrong')}
      </Button>
      <Button
        onClick={primary.onClick}
        disabled={!canWrite || primary.disabled || blocked}
        title={lockedTitle ?? primary.title}
        aria-keyshortcuts={primaryShortcut}
      >
        {primary.label}
      </Button>
    </>
  )
}

/* ------------------------------------------------------------------ drawer */

/**
 * The template inside the Rutin drawer: one column. The proposal comes
 * before the underlag here (the file is tall, and what posts must be read
 * without scrolling past it); the full page sets them side by side.
 */
export function ProposalReviewDrawerBody({
  op,
  origin,
  retrieved,
  banner,
  outcome,
  historyTrailing,
}: {
  op: PendingOperation
  origin: string | null
  retrieved: string | null
  /** The period-lock notice, above everything. */
  banner?: ReactNode
  /** How a resolved proposal ended (rejected why, signing step, expired), in the page's own words. */
  outcome?: ReactNode
  historyTrailing?: ReactNode
}) {
  const amount = headlineAmount(op)
  return (
    <div className="space-y-5">
      {banner}
      {(amount || op.risk_level !== 'low') && (
        <div className="flex items-center gap-3">
          <ReviewAmount op={op} className="min-w-0 flex-1" />
          <ReviewRisk op={op} />
        </div>
      )}
      <ReviewAttention op={op} />
      <ReviewProposal op={op} />
      <ReviewUnderlag op={op} viewerClassName="h-[56vh]" />
      {outcome}
      <ReviewHistory op={op} origin={origin} retrieved={retrieved} trailing={historyTrailing} />
    </div>
  )
}

/* -------------------------------------------------------------------- page */

export interface ReviewQueueGroup {
  key: string
  /** The run's band: who staged it and which day. */
  label: string
  ops: PendingOperation[]
}

/** Skeleton of the step, in its real columns (convention 17). */
export function ReviewWalkLoading() {
  return (
    <LateReveal>
      <div className={WALK_GRID_CLASS}>
        <div className="hidden space-y-2 lg:block">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[22px] w-full rounded-sm" />
          ))}
        </div>
        <div className="space-y-5">
          <div className="flex items-start gap-6 md:min-h-[4.75rem]">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-7 w-2/3 rounded-sm" />
              <Skeleton className="h-4 w-1/3 rounded-sm" />
            </div>
            <Skeleton className="h-8 w-32 rounded-sm" />
          </div>
          <div className="@container">
            <div className={WALK_COLUMNS_CLASS}>
              <Skeleton className="order-last h-64 w-full rounded-lg @[700px]:order-none" />
              <div className="space-y-2">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-9 w-full rounded-sm" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </LateReveal>
  )
}

const WALK_GRID_CLASS = 'grid grid-cols-[minmax(0,1fr)] gap-x-8 lg:grid-cols-[200px_minmax(0,1fr)]'
// The two slots of the step, in the same place for every proposal: the
// underlag on the left, what is proposed on the right, once the step is wide
// enough for both (its own width, not the window's). Narrower, the proposal
// comes first and the file after it.
const WALK_COLUMNS_CLASS =
  'grid grid-cols-[minmax(0,1fr)] items-start gap-6 @[700px]:grid-cols-[minmax(280px,5fr)_minmax(400px,6fr)] @[700px]:gap-x-8'

/**
 * The queue's name for a proposal: the staged title without its leading type
 * ("Kategorisera: "), which the step's own head states. In a 200px column
 * the type alone filled the line and the counterparty was cut.
 */
function queueName(title: string): string {
  const cut = title.indexOf(': ')
  return cut > 0 && cut <= 30 && cut + 2 < title.length ? title.slice(cut + 2) : title
}

/**
 * The full-page review, laid out as the guided step in Att göra (GuidedSteps
 * in components/dashboard/att-gora-views.tsx): the queue of proposals per run
 * in a left column, the proposal on the template, and the step's bar fixed to
 * the bottom of the panel (above the bottom nav on a phone) with the
 * progress, Föregående, Hoppa över, "Ser fel ut" and the one primary.
 *
 * Keys: j or the right arrow steps on, k or the left arrow steps back, Enter
 * presses the primary (never while a button, a link or a field has the
 * focus, or a dialog is open), Esc leaves for the list.
 */
export function ReviewWalk({
  groups,
  op,
  position,
  kicker,
  origin,
  retrieved,
  banner,
  historyTrailing,
  note,
  blocked,
  primary,
  onReject,
  rejectDisabled,
  onStep,
  remaining,
  gone,
  failure = null,
  queueMarks,
}: {
  groups: ReviewQueueGroup[]
  /** The proposal on screen; null once the walk is through, or when the linked one is no longer waiting. */
  op: PendingOperation | null
  position: StepPosition
  /** Type, who proposed it for whom, and when. */
  kicker: string
  origin: string | null
  retrieved: string | null
  banner?: ReactNode
  historyTrailing?: ReactNode
  /** The consequence sentence, or what is missing. */
  note: string
  blocked: boolean
  primary: ReviewPrimary | null
  onReject: () => void
  rejectDisabled?: boolean
  onStep: (id: string | null) => void
  /** Proposals still waiting in Rutin. */
  remaining: number
  /** The linked proposal is not waiting any more (approved or rejected elsewhere). */
  gone: boolean
  /**
   * The last approval of the proposal on screen did not go through: the
   * server's sentence (and where to fix it) takes the consequence sentence's
   * place in the bar. The proposal still waits; the primary sends it again.
   */
  failure?: { message: string; action?: ReactNode } | null
  /** Proposals in the queue whose last approval did not go through, and the word that says how (refused, not sent). */
  queueMarks?: ReadonlyMap<string, string>
}) {
  const t = useTranslations('pending')
  const tHem = useTranslations('hem')
  const router = useRouter()
  const { canWrite } = useViewerLock()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const currentRef = useRef<HTMLButtonElement>(null)
  const shownId = useRef<string | null>(null)

  // What the keys act on, as it is when the key is pressed.
  const keyState = useRef({ position, primary, blocked, canWrite, onStep })
  useEffect(() => {
    keyState.current = { position, primary, blocked, canWrite, onStep }
  })
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      // An overlay (the reject dialog, a confirmation, a menu) owns the keys while it is open.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      const state = keyState.current
      if (event.key === 'j' || event.key === 'ArrowRight') {
        if (state.position.next === null) return
        event.preventDefault()
        state.onStep(state.position.next)
      } else if (event.key === 'k' || event.key === 'ArrowLeft') {
        if (state.position.previous === null) return
        event.preventDefault()
        state.onStep(state.position.previous)
      } else if (event.key === 'Enter') {
        // Enter on a button, a link or the file is that control's own.
        if (target?.closest('button, a, summary, iframe, object, embed, [role="button"]')) return
        if (!state.primary || state.primary.disabled || state.blocked || !state.canWrite) return
        event.preventDefault()
        state.primary.onClick()
      } else if (event.key === 'Escape') {
        router.push('/pending')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [router])

  // A new proposal on screen (stepped to, or the one before it was approved):
  // it starts at its top, the queue shows where it is, and the focus is never
  // left on nothing, so the next key goes to this proposal.
  const opId = op?.id ?? null
  useEffect(() => {
    if (!opId) return
    const first = shownId.current === null
    shownId.current = opId
    currentRef.current?.scrollIntoView({ block: 'nearest' })
    if (!first) titleRef.current?.closest('main')?.scrollTo({ top: 0 })
    if (!document.activeElement || document.activeElement === document.body) titleRef.current?.focus({ preventScroll: true })
  }, [opId])

  if (!op || !primary) {
    return gone ? (
      <EmptyState title={t('already_resolved')} actionLabel={t('review_back')} actionHref="/pending" />
    ) : (
      <EmptyState
        tone="done"
        icon={CheckIcon}
        title={remaining === 0 ? t('empty_pending_title') : t('review_done_title')}
        description={remaining === 0 ? undefined : t('review_done_body', { count: remaining })}
        actionLabel={t('review_back')}
        actionHref="/pending"
      />
    )
  }

  const attention = reviewReason(op).attention

  return (
    <div className={WALK_GRID_CLASS}>
      {/* Says which proposal is on screen when it changes (an approval moves on by itself). */}
      <p className="sr-only" role="status" aria-live="polite" data-ph-mask="">
        {t('review_live_position', { index: position.index + 1, count: position.count, title: op.title })}
      </p>

      {/* The queue: where you are and what comes next. Beside the step on a
          wide screen, with its own scroll so the current proposal stays in
          view; left out on a narrow one (the bar counts). */}
      <nav
        className="-mx-2 hidden self-start px-2 lg:sticky lg:top-16 lg:block lg:max-h-[calc(100dvh-10.5rem)] lg:overflow-y-auto"
        aria-label={t('review_queue_label')}
      >
        {groups.map((group, groupIndex) => (
          <div key={group.key}>
            <p
              className={cn('truncate pb-1 text-xs font-medium text-muted-foreground', groupIndex === 0 ? 'pt-1.5' : 'pt-4')}
              title={group.label}
              data-ph-mask=""
            >
              {group.label}
            </p>
            {group.ops.map((item) => {
              const on = item.id === op.id
              const mark = queueMarks?.get(item.id) ?? null
              return (
                <button
                  key={item.id}
                  ref={on ? currentRef : undefined}
                  type="button"
                  aria-current={on ? 'step' : undefined}
                  aria-label={mark ? `${item.title}, ${mark}` : item.title}
                  title={item.title}
                  onClick={() => onStep(item.id)}
                  className={cn(
                    '-mx-2 flex min-h-[30px] w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70',
                    on ? 'bg-secondary font-medium text-strong' : 'hover:bg-secondary/60',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate" data-ph-mask="">
                    {queueName(item.title)}
                  </span>
                  {mark ? (
                    <span className="shrink-0 text-xs font-normal text-attn" data-refused="">
                      {mark}
                    </span>
                  ) : (
                    on && <span className="shrink-0 text-xs font-normal text-muted-foreground">{tHem('queue_now')}</span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="flex min-w-0 flex-col max-md:pb-52 md:min-h-[calc(100dvh-7.25rem)]">
        {/* Head: what it is, who proposed it for whom and when, the amount.
            Its height is the same for a one-line and a two-line title, so the
            slots under it never move between proposals. */}
        <header className="flex items-start gap-x-6 gap-y-2 max-sm:flex-wrap md:min-h-[4.75rem]">
          <div className="min-w-0 flex-1 basis-64">
            <h2
              ref={titleRef}
              tabIndex={-1}
              className="break-words text-xl text-strong outline-none md:line-clamp-2"
              title={op.title}
              data-ph-mask=""
            >
              {op.title}
            </h2>
            <p className="mt-0.5 break-words text-[13px] text-muted-foreground md:truncate" title={kicker} data-ph-mask="">
              {kicker}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1 max-sm:flex-row max-sm:items-center max-sm:gap-3">
            <ReviewAmount op={op} />
            <ReviewRisk op={op} />
          </div>
        </header>

        {/* The one attention line and the period lock: a line is kept for
            them, so a proposal with a short warning sits where one without does. */}
        <div className="mt-2 space-y-2 md:min-h-5">
          {banner}
          {attention && <ReviewAttention op={op} />}
        </div>

        <div className="@container mt-4 pb-6">
          <div className={WALK_COLUMNS_CLASS}>
            <div className="order-last min-w-0 @[700px]:order-none">
              <ReviewUnderlag op={op} viewerClassName="h-[min(62vh,640px)]" slot />
            </div>
            <div className="min-w-0 space-y-3">
              <ReviewProposal op={op} />
              <ReviewHistory key={op.id} op={op} origin={origin} retrieved={retrieved} trailing={historyTrailing} />
            </div>
          </div>
        </div>

        {/* The step's bar, always in view: the progress and the way past on
            the left, what the approval does (or what is missing) in the
            middle, "Ser fel ut" and the one primary last. */}
        <div
          {...PAGE_BOTTOM_BAR_PROPS}
          className="z-10 mt-auto flex flex-wrap items-center gap-x-2 gap-y-2 border-t-hairline bg-background py-3 max-md:fixed max-md:inset-x-0 max-md:bottom-[var(--bottom-nav-h)] max-md:px-4 md:sticky md:bottom-0 md:-mb-8"
        >
          <span className="whitespace-nowrap pr-1 text-xs tabular-nums text-muted-foreground">
            {tHem('borja_progress', { index: position.index + 1, count: position.count })}
          </span>
          <Button
            variant="ghost"
            disabled={position.previous === null}
            aria-keyshortcuts="k ArrowLeft"
            onClick={() => onStep(position.previous)}
          >
            {t('review_previous')}
          </Button>
          <Button variant="ghost" aria-keyshortcuts="j ArrowRight" onClick={() => onStep(position.next)}>
            {tHem('borja_skip')}
          </Button>
          {failure ? (
            <p className="min-w-0 flex-1 basis-56 break-words text-xs text-attn max-md:order-first max-md:basis-full md:px-2" data-ph-mask="">
              {failure.message} {failure.action}
            </p>
          ) : (
            note && (
              <p
                className={cn(
                  'min-w-0 flex-1 basis-56 text-xs max-md:order-first max-md:basis-full md:px-2',
                  blocked ? 'text-attn' : 'text-muted-foreground',
                )}
              >
                {note}
              </p>
            )
          )}
          <span className="ml-auto flex items-center justify-end gap-2 max-md:w-full max-md:[&>*]:flex-1">
            <ReviewActionButtons
              primary={primary}
              blocked={blocked}
              onReject={onReject}
              rejectDisabled={rejectDisabled}
              primaryShortcut="Enter"
            />
          </span>
        </div>
      </div>
    </div>
  )
}
