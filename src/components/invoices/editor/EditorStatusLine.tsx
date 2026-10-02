'use client'

import { useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { cn } from '@/lib/utils'
import type { EditorStatusLine as StatusLine } from '@/lib/invoices/editor/status-line'

interface EditorStatusLineProps<TStep> {
  status: StatusLine<TStep>
  /** The sentence and link text of a missing-field step. */
  describeStep: (step: TStep) => { prefix: string; label: string }
  onStep: (step: TStep) => void
  /** Owner/admin may add payment details here; others are asked to get one. */
  canAddPayee: boolean
  onAddPayee: () => void
  /** Jump to the invoice date (it is in a locked or closed period). */
  onFixDate?: () => void
  className?: string
}

/**
 * The editor's single status line (lib/invoices/editor/status-line.ts):
 * blockers in the one ochre attention sentence with a jump link, a page
 * split as muted information, nothing when all is well. aria-live so the
 * sentence follows the form without moving focus.
 */
export function EditorStatusLine<TStep>({
  status,
  describeStep,
  onStep,
  canAddPayee,
  onAddPayee,
  onFixDate,
  className,
}: EditorStatusLineProps<TStep>) {
  const t = useTranslations('invoice_editor_shell')

  let content: React.ReactNode = null
  if (status.kind === 'step') {
    const { prefix, label } = describeStep(status.step)
    content = (
      <AttnLine action={{ label, onClick: () => onStep(status.step) }}>{prefix}</AttnLine>
    )
  } else if (status.kind === 'date_locked') {
    content = (
      <AttnLine action={onFixDate ? { label: t('status_date_fix'), onClick: onFixDate } : undefined}>
        {t(`status_date_${status.lock}`)}
      </AttnLine>
    )
  } else if (status.kind === 'payee_missing') {
    content = canAddPayee ? (
      <AttnLine action={{ label: t('status_payee_add'), onClick: onAddPayee }}>{t('status_payee_missing')}</AttnLine>
    ) : (
      <AttnLine>
        {t('status_payee_missing')} {t('status_payee_ask_admin')}
      </AttnLine>
    )
  } else if (status.kind === 'preview_failed') {
    content = <AttnLine>{t('status_preview_failed')}</AttnLine>
  } else if (status.kind === 'split') {
    const key =
      status.cause === 'note'
        ? 'status_split_note'
        : status.cause === 'rows'
          ? 'status_split_rows'
          : status.cause === 'deduction'
            ? 'status_split_deduction'
            : 'status_split_other'
    content = <p className="text-[12.5px] leading-5 text-muted-foreground">{t(key, { pages: status.pages })}</p>
  }

  return (
    <div className={cn('min-h-5', className)} aria-live="polite">
      {content}
    </div>
  )
}
