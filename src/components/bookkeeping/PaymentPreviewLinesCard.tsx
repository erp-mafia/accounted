'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import { voucherLineViews } from '@/lib/bookkeeping/voucher-line-view'
import { useAccounts } from '@/lib/reference-data/hooks'
import { useBasCatalog } from '@/lib/hooks/use-bas-catalog'
import { cn, formatCurrency } from '@/lib/utils'
import type { LineDimensions } from './payment-line-dimensions'
import {
  UNEDITED_VALIDATION,
  blankEditableLine,
  previewToEditable,
  toLinePayload,
  validateEditableLines,
  type EditablePaymentLine,
  type PaymentLinePayload,
  type PaymentLinesValidation,
  type PaymentPreviewLine,
} from './payment-preview-lines'

export interface PaymentPreviewEditor {
  isEditing: boolean
  /** The working rows while editing; empty otherwise. */
  lines: EditablePaymentLine[]
  validation: PaymentLinesValidation
  /** The rows to send: the edited grid while editing and valid, else undefined (the route's default booking). */
  payload: PaymentLinePayload[] | undefined
  toggleEditing: () => void
  stopEditing: () => void
  reset: () => void
  addLine: () => void
  removeLine: (index: number) => void
  updateLine: (index: number, patch: Partial<EditablePaymentLine>) => void
}

/**
 * The edit state behind PaymentPreviewLinesCard. Read-only by default: the
 * rows shown are the preview's, and what books is the route's own default.
 * "Redigera" copies the preview into a working grid; from then on the grid
 * is what books, as long as it balances. "Klart" leaves edit mode and goes
 * back to the preview's rows. A preview that refetches while the user edits
 * does not overwrite the grid.
 */
export function usePaymentPreviewEditor(
  previewLines: readonly PaymentPreviewLine[] | null | undefined,
  documentDimensions?: LineDimensions | null,
): PaymentPreviewEditor {
  const [edited, setEdited] = useState<EditablePaymentLine[] | null>(null)
  const isEditing = edited !== null

  const fromPreview = useCallback(
    () => (previewLines ?? []).map(previewToEditable),
    [previewLines],
  )
  const validation = useMemo(
    () => (edited ? validateEditableLines(edited) : UNEDITED_VALIDATION),
    [edited],
  )
  const payload = useMemo(
    () => (edited && validation.isValid ? toLinePayload(edited) : undefined),
    [edited, validation.isValid],
  )

  // Stable identities: hosts call stopEditing from their own effects.
  const toggleEditing = useCallback(() => setEdited((prev) => (prev ? null : fromPreview())), [fromPreview])
  const stopEditing = useCallback(() => setEdited(null), [])
  const reset = useCallback(() => setEdited((prev) => (prev ? fromPreview() : prev)), [fromPreview])
  const addLine = useCallback(
    () => setEdited((prev) => (prev ? [...prev, blankEditableLine(documentDimensions)] : prev)),
    [documentDimensions],
  )
  const removeLine = useCallback(
    (index: number) => setEdited((prev) => (prev ? prev.filter((_, i) => i !== index) : prev)),
    [],
  )
  const updateLine = useCallback(
    (index: number, patch: Partial<EditablePaymentLine>) =>
      setEdited((prev) => (prev ? prev.map((l, i) => (i === index ? { ...l, ...patch } : l)) : prev)),
    [],
  )

  return {
    isEditing,
    lines: edited ?? [],
    validation,
    payload,
    toggleEditing,
    stopEditing,
    reset,
    addLine,
    removeLine,
    updateLine,
  }
}

interface PaymentPreviewLinesCardProps {
  editor: PaymentPreviewEditor
  /** The preview's rows for the read-only table; null shows none (a failed or unplaced preview). */
  lines: readonly PaymentPreviewLine[] | null
  /** Offer Redigera/Klart (and Återställ while editing). */
  canEdit: boolean
  disabled?: boolean
  /** Notices between the header and the rows, e.g. why there is no preview. */
  children?: ReactNode
}

/**
 * The "Bokföring" card of a payment dialog: the verifikat rows the booking
 * will post, read-only, with a Redigera toggle that turns them into an edit
 * grid (account, text, side, amount) with live balance and account checks.
 * Every amount is SEK, the bookkeeping home currency, whatever the payment's
 * currency: the preview routes state every row in SEK.
 */
export function PaymentPreviewLinesCard({
  editor,
  lines,
  canEdit,
  disabled = false,
  children,
}: PaymentPreviewLinesCardProps) {
  const t = useTranslations('tx_invoice_match')
  const tJournal = useTranslations('journal_form')
  const { accounts } = useAccounts()
  // The full BAS catalog, so an account the company has not activated yet
  // can still be picked (AccountCombobox activates it on use).
  const { catalog } = useBasCatalog()
  const { validation } = editor

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t('booking_title')}</p>
        {canEdit && (
          <div className="flex gap-2">
            {editor.isEditing && (
              <Button variant="ghost" size="sm" onClick={editor.reset} disabled={disabled}>
                {t('booking_reset')}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={editor.toggleEditing} disabled={disabled}>
              {editor.isEditing ? (
                t('booking_done_editing')
              ) : (
                <>
                  <PencilIcon className="h-3 w-3 mr-1" />
                  {t('booking_edit')}
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      {children}

      {lines && !editor.isEditing && (
        <VoucherLinesTable
          withCurrency
          lines={voucherLineViews(lines)}
        />
      )}

      {editor.isEditing && (
        <div className="space-y-2">
          {editor.lines.map((line, i) => (
            <div
              key={i}
              className="grid grid-cols-[minmax(180px,1.6fr)_minmax(0,1fr)_140px_110px_28px] gap-2 items-center"
            >
              <AccountCombobox
                value={line.account_number}
                accounts={accounts}
                catalog={catalog}
                notActivatedLabel={tJournal('account_not_activated')}
                onChange={(acc) => editor.updateLine(i, { account_number: acc })}
              />
              <Input
                value={line.description}
                onChange={(e) => editor.updateLine(i, { description: e.target.value })}
                placeholder={t('booking_description_placeholder')}
              />
              {/* Side toggle: picking a side keeps the amount. */}
              <div className="inline-flex rounded-lg border bg-background overflow-hidden h-9">
                <button
                  type="button"
                  onClick={() => editor.updateLine(i, { side: 'debit' })}
                  className={cn(
                    'flex-1 px-2 text-xs font-medium transition-colors',
                    line.side === 'debit'
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/60',
                  )}
                  aria-pressed={line.side === 'debit'}
                >
                  {t('booking_debit')}
                </button>
                <button
                  type="button"
                  onClick={() => editor.updateLine(i, { side: 'credit' })}
                  className={cn(
                    'flex-1 px-2 text-xs font-medium border-l transition-colors',
                    line.side === 'credit'
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/60',
                  )}
                  aria-pressed={line.side === 'credit'}
                >
                  {t('booking_credit')}
                </button>
              </div>
              <Input
                inputMode="decimal"
                value={line.amount}
                onChange={(e) => editor.updateLine(i, { amount: e.target.value })}
                className="text-right tabular-nums"
                placeholder="0"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => editor.removeLine(i)}
                disabled={editor.lines.length <= 2}
                aria-label={t('booking_remove_line')}
              >
                <TrashIcon className="h-3 w-3" />
              </Button>
            </div>
          ))}

          <div className="flex items-center justify-between pt-1">
            <Button variant="ghost" size="sm" onClick={editor.addLine}>
              <PlusIcon className="h-3 w-3 mr-1" />
              {t('booking_add_line')}
            </Button>
            <div className="text-xs tabular-nums text-muted-foreground">
              {t('booking_debit')} {formatCurrency(validation.totalDebit, 'SEK')}
              {' / '}
              {t('booking_credit')} {formatCurrency(validation.totalCredit, 'SEK')}
            </div>
          </div>

          {!validation.isBalanced && (
            <p className="text-xs text-destructive">
              {t('booking_unbalanced', { diff: formatCurrency(Math.abs(validation.diff), 'SEK') })}
            </p>
          )}
          {validation.accountInvalid && (
            <p className="text-xs text-destructive">{t('booking_account_invalid')}</p>
          )}
        </div>
      )}
    </div>
  )
}
