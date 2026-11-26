'use client'

// What a row's Godkänn in Rutin does, shown before the click. For low and
// medium risk the click is the approval, so the person reads the accounts it
// books here first. Drawn from the proposal the list already holds, and
// nothing is fetched on hover, except the rows of a proposal whose approval
// builds them at the click (a supplier invoice from the inbox): those are
// asked of the server at each opening, once the card has been open a moment,
// and worked out with the approval's own code (built-verifikat.ts). Each
// verifikat is the review's own table.

import { useEffect, useState, type ReactElement } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/info-tooltip'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import type { PostingLineLike } from '@/lib/bookkeeping/voucher-line-view'
import { verifikatBuiltAtApproval, type ApprovalVerifikatAnswer } from '@/lib/pending-operations/built-at-approval'
import type { PendingOperation } from '@/types'
import { askBuiltVerifikat, BUILT_VERIFIKAT_ASK_AFTER_MS } from './built-verifikat'
import { StagedLinesTable } from './OperationPreview'
import { FactRows, ReviewTitleContext } from './preview-parts'
import { approvalPreviewOf, type ApprovalPreview } from './review-model'
import { singleActionWarning } from './vocabulary'

type PreviewOp = Pick<PendingOperation, 'operation_type' | 'params' | 'preview_data' | 'title'>

type T = ReturnType<typeof useTranslations>

/** The rows of a proposal whose approval builds them at the click, as far as the card has them. */
export type BuiltRows =
  | { state: 'asking' }
  | { state: 'answered'; answer: ApprovalVerifikatAnswer }
  | { state: 'failed' }

interface CardParts {
  /** Why the button is locked: the read-only member, the locked period, the missing field. */
  lockedReason: string | null
  /** What the click does, in the type's own sentence; empty for a type without one. */
  sentence: string
  preview: ApprovalPreview
  /** Null for a proposal whose staged preview states its rows itself. */
  built: BuiltRows | null
}

function cardParts(op: PreviewOp, lockedReason: string | null | undefined, t: T, built: BuiltRows | null): CardParts {
  const answer = built?.state === 'answered' ? built.answer : null
  return {
    lockedReason: lockedReason || null,
    sentence: singleActionWarning(op.operation_type, op.params, t, op.preview_data),
    // Rows built at the click are only ever the server's: none until it answers.
    preview: approvalPreviewOf(
      op,
      built ? (answer?.posts === 'verifikat' ? answer.verifikat.map((entry) => entry.lines) : []) : undefined,
    ),
    built,
  }
}

const isEmpty = ({ lockedReason, sentence, preview, built }: CardParts) =>
  !lockedReason && !sentence && !built && preview.facts.length === 0 && preview.verifikat.length === 0

/** Where the rows go while a proposal's own are asked for, or why there are none. */
function BuiltRowsState({ built, lockedReason }: { built: BuiltRows; lockedReason: string | null }) {
  const t = useTranslations('pending')
  const locale = useLocale()
  if (built.state === 'asking') {
    return (
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">{t('review_posts_heading')}</p>
        <LateReveal className="space-y-1.5">
          <Skeleton className="h-4 w-full rounded-sm" />
          <Skeleton className="h-4 w-full rounded-sm" />
          <Skeleton className="h-4 w-full rounded-sm" />
        </LateReveal>
      </div>
    )
  }
  if (built.state === 'failed') return <p className="text-xs text-muted-foreground">{t('preview_link_lines_failed')}</p>
  const { answer } = built
  if (answer.posts === 'refused') {
    const reason = locale === 'en' ? answer.message_en : answer.message_sv
    // One attention line per card: a locked button's reason already holds it.
    return lockedReason ? <p className="text-xs text-muted-foreground">{reason}</p> : <AttnLine>{reason}</AttnLine>
  }
  if (answer.posts === 'at_approval') {
    return <p className="text-xs text-muted-foreground">{t('approve_preview_rate_at_approval')}</p>
  }
  return <p className="text-xs text-muted-foreground">{t('approve_preview_books_nothing')}</p>
}

function Card({ title, parts }: { title: string; parts: CardParts }) {
  const t = useTranslations('pending')
  const { lockedReason, sentence, preview, built } = parts
  return (
    <div className="space-y-3">
      {lockedReason && <AttnLine>{lockedReason}</AttnLine>}
      {sentence && <p className="text-muted-foreground">{sentence}</p>}
      {preview.facts.length > 0 && <FactRows groups={[preview.facts]} />}
      {preview.verifikat.length > 0 ? (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">{t('review_posts_heading')}</p>
          {/* A line text the title already says (a categorisation's bank text) is not repeated on every row. */}
          <ReviewTitleContext.Provider value={title}>
            <div className="space-y-2">
              {preview.verifikat.map(({ lines, listed }, index) => (
                <StagedLinesTable key={index} lines={lines as PostingLineLike[]} showTotals maxRows={listed} />
              ))}
            </div>
          </ReviewTitleContext.Provider>
          {preview.hiddenVerifikat > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('approve_preview_more_verifikat', { count: preview.hiddenVerifikat })}
            </p>
          )}
          {/* The review lists the staged rows; rows built at the click are only here. */}
          {preview.truncated && !built && <p className="mt-1 text-xs text-muted-foreground">{t('approve_preview_rest')}</p>}
        </div>
      ) : (
        built && <BuiltRowsState built={built} lockedReason={lockedReason} />
      )}
    </div>
  )
}

/**
 * The card on its own: what the hover shows. Null when the proposal states
 * nothing to show. `built` is what the card has of the rows a proposal's
 * approval builds at the click; until the server answers, they are asked for.
 */
export function ApprovalPreviewCard({
  op,
  lockedReason,
  built,
}: {
  op: PreviewOp
  lockedReason?: string | null
  built?: BuiltRows
}) {
  const t = useTranslations('pending')
  const parts = cardParts(op, lockedReason, t, verifikatBuiltAtApproval(op) ? (built ?? { state: 'asking' }) : null)
  return isEmpty(parts) ? null : <Card title={op.title} parts={parts} />
}

/**
 * The rows the approval of this proposal builds at the click, asked of the
 * server once the card has been open BUILT_VERIFIKAT_ASK_AFTER_MS, and again
 * at every opening: an answer asked at an earlier opening, or for an earlier
 * object of the proposal (the list reloaded), is never shown. A card closed
 * before then asks nothing, also while it fades out. Held here, above the
 * card: Radix renders a tooltip's content twice (once for screen readers),
 * and the card asks once.
 */
function useBuiltRows(op: PreviewOp & { id: string }, asking: boolean, opening: number): BuiltRows {
  const [seen, setSeen] = useState<{ op: object; opening: number; rows: BuiltRows } | null>(null)
  useEffect(() => {
    if (!asking) return
    let current = true
    const timer = setTimeout(() => {
      askBuiltVerifikat(op.id).then(
        (answer) => {
          if (current) setSeen({ op, opening, rows: { state: 'answered', answer } })
        },
        () => {
          if (current) setSeen({ op, opening, rows: { state: 'failed' } })
        },
      )
    }, BUILT_VERIFIKAT_ASK_AFTER_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [op, asking, opening])
  return seen?.op === op && seen.opening === opening ? seen.rows : { state: 'asking' }
}

/**
 * A row's Godkänn with the card on hover and on keyboard focus; the click is
 * the button's own and closes the card. The button is the trigger, so a
 * screen reader hears the card as its description. A disabled button takes no
 * pointer events and no focus: a span around it is the trigger instead,
 * reached with Tab, and the reason it is locked, once its title, is the
 * card's first line. Touch has no hover, and a tap never opens it.
 */
export function ApprovalHoverPreview({
  op,
  lockedReason,
  disabled,
  off = false,
  children,
}: {
  op: PreviewOp & { id: string }
  lockedReason?: string | null
  /** The button is disabled. */
  disabled: boolean
  /** No card: the button opens a review of its own (a daily batch's Granska). */
  off?: boolean
  /** The Godkänn button. */
  children: ReactElement
}) {
  const t = useTranslations('pending')
  // The card's state, followed (not controlled), with each opening counted.
  const [card, setCard] = useState({ open: false, opening: 0 })
  const builtAtApproval = !off && verifikatBuiltAtApproval(op)
  const built = useBuiltRows(op, builtAtApproval && card.open, card.opening)
  if (off) return children
  const parts = cardParts(op, lockedReason, t, builtAtApproval ? built : null)
  if (isEmpty(parts)) return children
  return (
    <Tooltip onOpenChange={(open) => setCard((was) => ({ open, opening: open ? was.opening + 1 : was.opening }))}>
      <TooltipTrigger asChild>
        {disabled ? (
          <span
            tabIndex={0}
            className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            {children}
          </span>
        ) : (
          children
        )}
      </TooltipTrigger>
      {/* data-ph-mask: amounts, accounts and counterparties are the company's
          data. The pointer may move onto the card to read it; a click there
          is no click on the row behind it, which opens the review. */}
      <TooltipContent
        side="left"
        sideOffset={8}
        collisionPadding={16}
        data-ph-mask=""
        className="w-[26rem] max-w-[calc(100vw-2rem)] p-3 text-[13px] leading-5"
        onClick={(event) => event.stopPropagation()}
      >
        <Card title={op.title} parts={parts} />
      </TooltipContent>
    </Tooltip>
  )
}
