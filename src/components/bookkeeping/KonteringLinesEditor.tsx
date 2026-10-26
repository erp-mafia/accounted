'use client'

import type { ComponentProps, ReactNode } from 'react'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { AccountNumber } from '@/components/ui/account-number'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn, formatAmount } from '@/lib/utils'
import { KONTERING_ICON_WIDTH_CLASS, konteringGridColumns } from '@/components/bookkeeping/kontering-grid'
import { PlusIcon, TrashIcon } from '@/components/icons'
import type { BASAccount } from '@/types'
import type { SearchableAccount } from '@/lib/bookkeeping/account-search'

/** One editable konteringsrad: the amounts stay the strings the user typed. */
export interface KonteringEditorLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  line_description?: string
}

export interface KonteringEditorLabels {
  account: string
  /** Present when the editor shows a description column. */
  description?: string
  /** The description input's placeholder; defaults to the column name. */
  descriptionPlaceholder?: string
  debit: string
  credit: string
  addRow: string
  removeRow: string
}

export type KonteringAmountField = 'debit_amount' | 'credit_amount'

/** What a caller may add to an amount input: its keyboard and fill-in flow. */
export type KonteringAmountInputExtras = Pick<
  ComponentProps<typeof Input>,
  'onKeyDown' | 'onFocus' | 'onDoubleClick' | 'title'
>

/** A row a line generates (e.g. its momskod's moms rows): shown, never edited. */
export interface KonteringReadOnlyLine {
  account_number: string
  line_description: string
  debit_amount: string
  credit_amount: string
}

interface KonteringLinesEditorProps {
  lines: readonly KonteringEditorLine[]
  accounts: BASAccount[]
  /** The BAS catalogue, for accounts the company has not activated yet. */
  catalog?: SearchableAccount[]
  notActivatedLabel?: string
  /** The account name shown under a picked account. */
  accountName?: (accountNumber: string) => string | undefined
  onAccountChange: (index: number, accountNumber: string) => void
  onAmountChange: (index: number, field: 'debit_amount' | 'credit_amount', value: string) => void
  /** Shows the description column; leave it out for account-and-amount rows. */
  onDescriptionChange?: (index: number, value: string) => void
  onAdd: () => void
  onRemove: (index: number) => void
  onCreateAccount?: (index: number, prefill: string) => void
  /** A row cannot be removed while the editor holds this many or fewer. */
  minLines?: number
  /** Locks the account pickers, e.g. while the chart is loading. */
  accountsDisabled?: boolean
  /**
   * Column heads above the rows on wide screens, and a label over each
   * amount on narrow ones. Without them the amounts carry their name as the
   * placeholder.
   */
  header?: boolean
  labels: KonteringEditorLabels
  /** The account picker's input per row, for the caller's focus flow. */
  accountInputRef?: (index: number, el: HTMLInputElement | null) => void
  /** A full account number was committed in the row's picker. */
  onAccountCommit?: (index: number) => void
  /** The amount inputs per row, for the caller's focus flow. */
  amountInputRef?: (index: number, field: KonteringAmountField, el: HTMLInputElement | null) => void
  amountInputProps?: (index: number, field: KonteringAmountField) => KonteringAmountInputExtras
  onDescriptionKeyDown?: (index: number) => ComponentProps<typeof Input>['onKeyDown']
  /** Under the description input: badges that belong to the row. */
  renderDescriptionExtra?: (index: number) => ReactNode
  /** One read-only column after the amounts, e.g. the account's saldo. */
  extraColumn?: { label: string; render: (index: number) => ReactNode }
  /**
   * Row controls placed before the remove button: at most two icon-sm
   * buttons, the width the column keeps on every row (kontering-grid.ts).
   */
  renderRowActions?: (index: number) => ReactNode
  /** Rows a line generates, listed under it in the same columns. */
  readOnlyLines?: (index: number) => { title?: string; lines: readonly KonteringReadOnlyLine[] } | undefined
  /** The sum row under the lines. */
  totals?: { label: string; debit: ReactNode; credit: ReactNode; amountClassName?: string }
  /** Buttons beside "add row". */
  toolbar?: ReactNode
}

/**
 * The konteringsrader of a booking dialog, rendered once: one grid that
 * stacks on a phone and lays the cells out in columns from `sm`. The
 * dialogs that used to mount a phone card list and a desktop table at the
 * same time (two account pickers per row) and the two correction dialogs'
 * copies of the same grid all use this.
 *
 * The DOM order is the tab order on every width: account, description,
 * debit, credit, remove. On a phone the remove button is placed beside the
 * account by the grid, not moved in the DOM.
 */
export function KonteringLinesEditor({
  lines,
  accounts,
  catalog,
  notActivatedLabel,
  accountName,
  onAccountChange,
  onAmountChange,
  onDescriptionChange,
  onAdd,
  onRemove,
  onCreateAccount,
  minLines = 2,
  accountsDisabled = false,
  header = true,
  labels,
  accountInputRef,
  onAccountCommit,
  amountInputRef,
  amountInputProps,
  onDescriptionKeyDown,
  renderDescriptionExtra,
  extraColumn,
  renderRowActions,
  readOnlyLines,
  totals,
  toolbar,
}: KonteringLinesEditorProps) {
  const withDescription = onDescriptionChange !== undefined
  const columns = konteringGridColumns(withDescription, extraColumn !== undefined, renderRowActions !== undefined)
  // The cells a sum or a generated row leaves empty after the amounts.
  const trailingCells = (extraColumn ? 1 : 0) + 1

  const amountInput = (index: number, field: KonteringAmountField, label: string) => (
    <div className="min-w-0 space-y-1 sm:space-y-0">
      {header && (
        <label htmlFor={`kontering-${index}-${field}`} className="block text-xs text-muted-foreground sm:hidden">
          {label}
        </label>
      )}
      <Input
        id={`kontering-${index}-${field}`}
        type="number"
        step="0.01"
        min="0"
        inputMode="decimal"
        placeholder={header ? '0,00' : label}
        aria-label={label}
        value={lines[index][field]}
        onChange={(e) => onAmountChange(index, field, e.target.value)}
        className="tabular-nums text-right"
        ref={amountInputRef ? (el) => amountInputRef(index, field, el) : undefined}
        {...amountInputProps?.(index, field)}
      />
    </div>
  )

  const readOnlyRows = (index: number) => {
    const generated = readOnlyLines?.(index)
    if (!generated || generated.lines.length === 0) return null
    return (
      <div className="col-span-2 space-y-1 text-xs text-muted-foreground sm:col-span-full" title={generated.title}>
        {generated.lines.map((line, gi) => (
          <div key={gi} className={cn('grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:items-center', columns)}>
            <span className="min-w-0 truncate sm:pl-3">
              <AccountNumber number={line.account_number} size="sm" />
              <span className="sm:hidden"> {line.line_description}</span>
            </span>
            {withDescription && <span className="hidden min-w-0 truncate sm:block">{line.line_description}</span>}
            <span className="text-right tabular-nums sm:hidden">
              {line.debit_amount
                ? `${labels.debit} ${formatAmount(parseFloat(line.debit_amount))}`
                : `${labels.credit} ${formatAmount(parseFloat(line.credit_amount))}`}
            </span>
            <span className="hidden text-right tabular-nums sm:block">
              {line.debit_amount ? formatAmount(parseFloat(line.debit_amount)) : ''}
            </span>
            <span className="hidden text-right tabular-nums sm:block">
              {line.credit_amount ? formatAmount(parseFloat(line.credit_amount)) : ''}
            </span>
            {Array.from({ length: trailingCells }, (_, i) => (
              <span key={i} className="hidden sm:block" />
            ))}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className={cn('space-y-2', KONTERING_ICON_WIDTH_CLASS)}>
      {header && (
        <div
          aria-hidden="true"
          className={cn('hidden gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid', columns)}
        >
          <span>{labels.account}</span>
          {withDescription && <span>{labels.description}</span>}
          <span className="text-right">{labels.debit}</span>
          <span className="text-right">{labels.credit}</span>
          {extraColumn && <span className="text-right">{extraColumn.label}</span>}
          <span />
        </div>
      )}

      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            'grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b pb-3 last:border-0 sm:items-start sm:border-0 sm:pb-0',
            columns,
          )}
        >
          {/* min-w-0: without it the combobox refuses to shrink below its
              content and overflows the dialog. */}
          <div className="min-w-0">
            <AccountCombobox
              value={line.account_number}
              accounts={accounts}
              catalog={catalog}
              notActivatedLabel={notActivatedLabel}
              onChange={(value) => onAccountChange(index, value)}
              onCreateAccount={onCreateAccount ? (prefill) => onCreateAccount(index, prefill) : undefined}
              onCommit={onAccountCommit ? () => onAccountCommit(index) : undefined}
              inputRef={accountInputRef ? (el) => accountInputRef(index, el) : undefined}
              selectedName={accountName?.(line.account_number)}
              disabled={accountsDisabled}
            />
          </div>
          {withDescription && (
            <div className="col-span-2 min-w-0 space-y-1 sm:col-span-1">
              <Input
                value={line.line_description ?? ''}
                onChange={(e) => onDescriptionChange(index, e.target.value)}
                onKeyDown={onDescriptionKeyDown?.(index)}
                placeholder={labels.descriptionPlaceholder ?? labels.description}
                aria-label={labels.description}
              />
              {renderDescriptionExtra?.(index)}
            </div>
          )}
          <div className="col-span-2 grid grid-cols-2 gap-2 sm:contents">
            {amountInput(index, 'debit_amount', labels.debit)}
            {amountInput(index, 'credit_amount', labels.credit)}
          </div>
          {extraColumn && (
            <div className="col-span-2 flex items-baseline justify-end gap-1 text-xs tabular-nums text-muted-foreground sm:col-span-1 sm:block sm:self-center sm:text-right sm:text-sm">
              {header && <span className="sm:hidden">{extraColumn.label}</span>}
              {extraColumn.render(index)}
            </div>
          )}
          <div className="col-start-2 row-start-1 flex items-center justify-end sm:col-start-auto sm:row-start-auto">
            {renderRowActions?.(index)}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => onRemove(index)}
              disabled={lines.length <= minLines}
              aria-label={labels.removeRow}
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </Button>
          </div>
          {readOnlyRows(index)}
        </div>
      ))}

      {totals && (
        <div
          className={cn(
            'grid grid-cols-[minmax(0,1fr)_auto_auto] gap-4 px-1 pt-2 text-sm font-semibold tabular-nums sm:gap-2',
            columns,
          )}
        >
          <span className={cn(withDescription && 'sm:col-span-2')}>{totals.label}</span>
          <span className={cn('text-right', totals.amountClassName)}>
            <span className="sm:hidden">{labels.debit} </span>
            {totals.debit}
          </span>
          <span className={cn('text-right', totals.amountClassName)}>
            <span className="sm:hidden">{labels.credit} </span>
            {totals.credit}
          </span>
          {Array.from({ length: trailingCells }, (_, i) => (
            <span key={i} className="hidden sm:block" />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onAdd} className={cn(!toolbar && 'w-full sm:w-auto')}>
          <PlusIcon className="mr-1 h-3.5 w-3.5" />
          {labels.addRow}
        </Button>
        {toolbar}
      </div>
    </div>
  )
}
