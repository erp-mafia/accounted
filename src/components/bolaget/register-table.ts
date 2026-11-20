import { cn } from '@/lib/utils'
import { TD_CLASS } from '@/components/ui/dry-table'

/** A column a phone leaves out, so the name and the figures fit without sideways scroll. */
export const PHONE_HIDDEN = 'hidden sm:table-cell'

/** The quiet actions that end a register row: 28px row buttons centred in the 44px row. */
export const ROW_ACTIONS_TD = cn(TD_CLASS, 'whitespace-nowrap py-2 text-right')

/** A row's own name or date when it opens the row's detail: body text, underlined on hover. */
export const NAME_LINK_CLASS = 'text-left text-strong underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none'

/** The Summa row that closes a register table. */
export const SUM_ROW_CLASS = 'font-medium text-strong'

/** A share of capital or votes, two decimals on every row so the column lines up. */
export function pct(value: number): string {
  return `${value.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`
}
