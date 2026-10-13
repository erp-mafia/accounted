'use client'

import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Plus, Trash2 } from 'lucide-react'
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
  debit: string
  credit: string
  addRow: string
  removeRow: string
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
}: KonteringLinesEditorProps) {
  const withDescription = onDescriptionChange !== undefined
  const columns = withDescription
    ? 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_120px_32px]'
    : 'sm:grid-cols-[minmax(0,1fr)_120px_120px_32px]'

  const amountInput = (index: number, field: 'debit_amount' | 'credit_amount', label: string) => (
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
      />
    </div>
  )

  return (
    <div className="space-y-2">
      {header && (
        <div
          aria-hidden="true"
          className={cn('hidden gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid', columns)}
        >
          <span>{labels.account}</span>
          {withDescription && <span>{labels.description}</span>}
          <span className="text-right">{labels.debit}</span>
          <span className="text-right">{labels.credit}</span>
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
              selectedName={accountName?.(line.account_number)}
              disabled={accountsDisabled}
            />
          </div>
          {withDescription && (
            <Input
              value={line.line_description ?? ''}
              onChange={(e) => onDescriptionChange(index, e.target.value)}
              placeholder={labels.description}
              aria-label={labels.description}
              className="col-span-2 sm:col-span-1"
            />
          )}
          <div className="col-span-2 grid grid-cols-2 gap-2 sm:contents">
            {amountInput(index, 'debit_amount', labels.debit)}
            {amountInput(index, 'credit_amount', labels.credit)}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="col-start-2 row-start-1 text-muted-foreground hover:text-destructive sm:col-start-auto sm:row-start-auto"
            onClick={() => onRemove(index)}
            disabled={lines.length <= minLines}
            aria-label={labels.removeRow}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={onAdd} className="w-full sm:w-auto">
        <Plus className="mr-1 h-3.5 w-3.5" />
        {labels.addRow}
      </Button>
    </div>
  )
}
