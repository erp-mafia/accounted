'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CashAccount } from '@/types'

interface MoveTransactionCashAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Enabled cash accounts to offer (the page's /api/cash-accounts?enabled_only=true list). */
  cashAccounts: CashAccount[]
  /** cash_accounts.id the transaction is currently bound to (null = unassigned). */
  currentCashAccountId: string | null
  /** Transaction currency: accounts in another currency cannot be picked
   *  (the server hard-rejects a cross-currency move). */
  currency: string
  /** Persist the move (PATCH). Resolves true on success (dialog closes),
   *  false to keep the dialog open (e.g. the request failed). */
  onMove: (accountNumber: string) => Promise<boolean>
}

/**
 * Move an unbooked bank transaction to another of the company's cash accounts.
 * Radio list of the enabled accounts (name + ledger account); the current
 * account is preselected and disabled so the user picks where the row should
 * go. Gating (only unbooked/unmatched rows) is enforced server-side; callers
 * only open this for movable rows.
 */
export default function MoveTransactionCashAccountDialog({
  open,
  onOpenChange,
  cashAccounts,
  currentCashAccountId,
  currency,
  onMove,
}: MoveTransactionCashAccountDialogProps) {
  const t = useTranslations('tx_inbox_card')
  const currentLedger =
    cashAccounts.find((a) => a.id === currentCashAccountId)?.ledger_account ?? null
  const [selected, setSelected] = useState<string | null>(currentLedger)
  const [isSaving, setIsSaving] = useState(false)

  // Re-seed the selection each time the dialog opens for a (possibly different) row.
  useEffect(() => {
    if (open) setSelected(currentLedger)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentCashAccountId])

  const canSave = selected !== null && selected !== currentLedger && !isSaving

  async function persist() {
    if (!canSave || selected === null) return
    setIsSaving(true)
    try {
      const ok = await onMove(selected)
      if (ok) onOpenChange(false)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isSaving) return
        onOpenChange(v)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('move_account_dialog_title')}</DialogTitle>
          <DialogDescription>{t('move_account_dialog_description')}</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label={t('move_account_dialog_title')} className="space-y-2">
          {cashAccounts.map((account) => {
            const isCurrent = account.id === currentCashAccountId
            const currencyMismatch = account.currency.toUpperCase() !== currency.toUpperCase()
            const disabled = isCurrent || currencyMismatch || isSaving
            return (
              <label
                key={account.id}
                className={cn(
                  'flex min-h-11 items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm transition-colors duration-150',
                  disabled ? 'opacity-60' : 'cursor-pointer hover:bg-secondary/35',
                  selected === account.ledger_account && !disabled && 'bg-secondary/40',
                )}
              >
                <input
                  type="radio"
                  name="move-cash-account"
                  value={account.ledger_account}
                  checked={selected === account.ledger_account}
                  onChange={() => setSelected(account.ledger_account)}
                  disabled={disabled}
                  className="h-4 w-4 shrink-0 accent-foreground"
                />
                <span className="min-w-0 flex-1 truncate">
                  {account.name || `Bankkonto ${account.currency}`}
                </span>
                {isCurrent && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t('move_account_current')}
                  </span>
                )}
                {!isCurrent && currencyMismatch && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t('move_account_currency_mismatch', { currency: account.currency })}
                  </span>
                )}
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {account.ledger_account}
                </span>
              </label>
            )
          })}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
            className="min-h-11 w-full sm:w-auto"
          >
            {t('move_account_cancel')}
          </Button>
          <Button
            onClick={() => void persist()}
            disabled={!canSave}
            className="min-h-11 w-full sm:w-auto"
          >
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t('move_account_save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
