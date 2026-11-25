'use client'

// What a row's Godkänn in Rutin does, shown before the click. For low and
// medium risk the click is the approval, so the person reads the accounts it
// books here first. Drawn from the proposal the list already holds: nothing
// is fetched on hover, and each verifikat is the review's own table.

import type { ReactElement } from 'react'
import { useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/info-tooltip'
import type { PostingLineLike } from '@/lib/bookkeeping/voucher-line-view'
import type { PendingOperation } from '@/types'
import { StagedLinesTable } from './OperationPreview'
import { FactRows, ReviewTitleContext } from './preview-parts'
import { approvalPreviewOf, type ApprovalPreview } from './review-model'
import { singleActionWarning } from './vocabulary'

type PreviewOp = Pick<PendingOperation, 'operation_type' | 'params' | 'preview_data' | 'title'>

type T = ReturnType<typeof useTranslations>

interface CardParts {
  /** Why the button is locked: the read-only member, the locked period, the missing field. */
  lockedReason: string | null
  /** What the click does, in the type's own sentence; empty for a type without one. */
  sentence: string
  preview: ApprovalPreview
}

function cardParts(op: PreviewOp, lockedReason: string | null | undefined, t: T): CardParts {
  return {
    lockedReason: lockedReason || null,
    sentence: singleActionWarning(op.operation_type, op.params, t, op.preview_data),
    preview: approvalPreviewOf(op),
  }
}

const isEmpty = ({ lockedReason, sentence, preview }: CardParts) =>
  !lockedReason && !sentence && preview.facts.length === 0 && preview.verifikat.length === 0

function Card({ title, parts }: { title: string; parts: CardParts }) {
  const t = useTranslations('pending')
  const { lockedReason, sentence, preview } = parts
  return (
    <div className="space-y-3">
      {lockedReason && <AttnLine>{lockedReason}</AttnLine>}
      {sentence && <p className="text-muted-foreground">{sentence}</p>}
      {preview.facts.length > 0 && <FactRows groups={[preview.facts]} />}
      {preview.verifikat.length > 0 && (
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
          {preview.truncated && <p className="mt-1 text-xs text-muted-foreground">{t('approve_preview_rest')}</p>}
        </div>
      )}
    </div>
  )
}

/** The card on its own: what the hover shows. Null when the proposal states nothing to show. */
export function ApprovalPreviewCard({ op, lockedReason }: { op: PreviewOp; lockedReason?: string | null }) {
  const t = useTranslations('pending')
  const parts = cardParts(op, lockedReason, t)
  return isEmpty(parts) ? null : <Card title={op.title} parts={parts} />
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
  op: PreviewOp
  lockedReason?: string | null
  /** The button is disabled. */
  disabled: boolean
  /** No card: the button opens a review of its own (a daily batch's Granska). */
  off?: boolean
  /** The Godkänn button. */
  children: ReactElement
}) {
  const t = useTranslations('pending')
  if (off) return children
  const parts = cardParts(op, lockedReason, t)
  if (isEmpty(parts)) return children
  return (
    <Tooltip>
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
