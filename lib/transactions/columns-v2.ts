/**
 * Transaktioner columns in shell v2 (dev_docs/ui_v2_build_plan.md, PR 4).
 * Fixed order; the user hides or shows the optional ones and the choice
 * persists in user_preferences.ui_state.tx_columns. Beskrivning and Status
 * cannot be hidden: the row would lose its name and its action.
 */

export const TX_COLUMN_IDS = ['date', 'description', 'category', 'account', 'amount', 'status'] as const

export type TxColumnId = (typeof TX_COLUMN_IDS)[number]

export interface TxColumnDef {
  id: TxColumnId
  /** Key in the `transactions` i18n namespace. */
  labelKey: string
  /** Can be hidden by the user. */
  optional: boolean
}

export const TX_COLUMNS: readonly TxColumnDef[] = [
  { id: 'date', labelKey: 'th_date', optional: true },
  { id: 'description', labelKey: 'th_description', optional: false },
  { id: 'category', labelKey: 'th_category', optional: true },
  { id: 'account', labelKey: 'th_account', optional: true },
  { id: 'amount', labelKey: 'th_amount', optional: true },
  { id: 'status', labelKey: 'th_status', optional: false },
]

export function isTxColumnId(value: string): value is TxColumnId {
  return (TX_COLUMN_IDS as readonly string[]).includes(value)
}

/**
 * Visible columns for a preference bag. Unknown ids are ignored (a renamed
 * column must not hide anything by accident) and required columns stay.
 */
export function resolveTxColumns(prefs?: { hidden?: readonly string[] } | null): ReadonlySet<TxColumnId> {
  const hidden = new Set((prefs?.hidden ?? []).filter(isTxColumnId))
  return new Set(TX_COLUMNS.filter((c) => !c.optional || !hidden.has(c.id)).map((c) => c.id))
}
