'use client'

import { useId, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { AccountNumber } from '@/components/ui/account-number'

export interface DeclarationAccountLine {
  accountNumber: string
  accountName: string
  amount: number
}

/**
 * Default formatter: whole kronor, matching the filed SRU values. Truncation,
 * not rounding: SFL "öretal faller bort" and the NE/INK2 SRU generators drop
 * öre with Math.trunc, so the UI must agree with the filed figures. Callers
 * that need öre pass their own formatter.
 */
export function formatWholeKronor(n: number): string {
  // + 0 normalizes -0 (Math.trunc(-0.3) is -0, which sv-SE renders "−0").
  return `${(Math.trunc(n) + 0).toLocaleString('sv-SE')} kr`
}

/**
 * One expandable declaration row (NE-bilaga, INK2): ruta code chip, label,
 * signed amount, and a per-account breakdown behind a keyboard-accessible
 * toggle. Replaces the copy-pasted <tr onClick> rows that had no keyboard
 * path, no aria-expanded, and double-encoded signs.
 *
 * `amount` is the SIGNED display value: expense callers pass the negated
 * value instead of an isExpense flag, so a credit-balance expense renders
 * with its true sign. Composes inside the Table primitive's TableBody.
 */
export function DeclarationRutaRow({
  code,
  label,
  amount,
  accounts = [],
  hideWhenZero = true,
  formatAmount = formatWholeKronor,
}: {
  code: string
  label: string
  amount: number
  accounts?: DeclarationAccountLine[]
  hideWhenZero?: boolean
  formatAmount?: (n: number) => string
}) {
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()

  if (amount === 0 && accounts.length === 0 && hideWhenZero) return null

  const hasAccounts = accounts.length > 0

  return (
    <>
      <tr
        className={`border-b ${hasAccounts ? 'cursor-pointer hover:bg-muted/50 transition-colors' : ''}`}
        onClick={() => hasAccounts && setExpanded((v) => !v)}
      >
        <td className="py-2">
          {hasAccounts && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              aria-label={expanded ? `Dölj konton för ${code}` : `Visa konton för ${code}`}
              className="mr-1 inline-flex h-6 w-6 items-center justify-center rounded align-middle hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(e) => {
                e.stopPropagation()
                setExpanded((v) => !v)
              }}
            >
              {expanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
          )}
          <span className="font-mono text-xs bg-muted px-1 rounded mr-2">{code}</span>
          {label}
          {hasAccounts && (
            <span className="text-xs text-muted-foreground ml-2">
              ({accounts.length} konton)
            </span>
          )}
        </td>
        <td className="py-2 text-right tabular-nums">{formatAmount(amount)}</td>
      </tr>
      {expanded && hasAccounts && (
        <tr id={panelId}>
          <td colSpan={2} className="py-2 pl-8 bg-muted/20">
            <table className="w-full text-xs">
              <tbody>
                {accounts.map((acc) => (
                  <tr key={acc.accountNumber}>
                    <td className="py-1">
                      <AccountNumber
                        number={acc.accountNumber}
                        name={acc.accountName}
                        size="sm"
                      />
                    </td>
                    <td className="py-1">{acc.accountName}</td>
                    <td className="py-1 text-right tabular-nums">
                      {formatAmount(acc.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  )
}
