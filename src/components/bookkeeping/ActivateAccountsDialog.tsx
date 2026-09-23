'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Loader2, Plus } from 'lucide-react'

export interface ActivateAccountsDialogProps {
  open: boolean
  accountNumbers: string[]
  onConfirm: () => Promise<void> | void
  onCancel: () => void
  // Optional: invoked when the user wants to create a custom (non-BAS) account
  // for a number that isn't in the BAS catalogue. The host should close this
  // dialog and open AddAccountDialog prefilled with the number.
  onCreateUnknown?: (accountNumber: string) => void
  // Confirm button label. Defaults to the bookkeeping wording; non-booking
  // hosts (e.g. the article register) pass their own.
  confirmLabel?: string
}

interface BasLookupRow {
  account_number: string
  account_name: string | null
  known: boolean
  // Present since the lookup learned about the company's own chart: an account
  // that is in_chart but not is_active is being reactivated, not added.
  in_chart?: boolean
  is_active?: boolean
}

export function ActivateAccountsDialog({
  open,
  accountNumbers,
  onConfirm,
  onCancel,
  onCreateUnknown,
  confirmLabel,
}: ActivateAccountsDialogProps) {
  const [rows, setRows] = useState<BasLookupRow[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open || accountNumbers.length === 0) return
    let cancelled = false
    setLoading(true)
    fetch(`/api/bookkeeping/accounts/bas-lookup?numbers=${encodeURIComponent(accountNumbers.join(','))}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return
        setRows((body?.data as BasLookupRow[]) || [])
      })
      .catch(() => {
        if (cancelled) return
        setRows(
          accountNumbers.map((n) => ({
            account_number: n,
            account_name: null,
            known: false,
            in_chart: false,
            is_active: false,
          })),
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, accountNumbers])

  const knownRows = rows.filter((r) => r.known)
  const unknownRows = rows.filter((r) => !r.known)
  // Disable confirm when any entered number isn't a valid BAS account: activating
  // only the knowns would leave the unknowns to fail again on retry.
  const canConfirm = knownRows.length > 0 && unknownRows.length === 0 && !submitting

  async function handleConfirm() {
    setSubmitting(true)
    try {
      await onConfirm()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Aktivera konton</DialogTitle>
          <DialogDescription>
            {knownRows.length > 0
              ? 'Följande konton behöver aktiveras i din kontoplan innan bokföringen kan slutföras.'
              : 'Inga giltiga BAS-konton att aktivera.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 text-sm">
          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Hämtar kontouppgifter...
            </div>
          )}

          {!loading && knownRows.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border">
              {knownRows.map((r) => (
                <li key={r.account_number} className="flex items-baseline gap-3 px-3 py-2">
                  <span className="font-mono text-foreground w-14 shrink-0">{r.account_number}</span>
                  <span className="truncate">{r.account_name}</span>
                  {r.in_chart && !r.is_active && (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      Aktiveras igen
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!loading && unknownRows.length > 0 && (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-attn">
              <p className="font-medium">Finns inte i BAS-katalogen:</p>
              <p className="mt-1 font-mono">{unknownRows.map((r) => r.account_number).join(', ')}</p>
              <p className="mt-1 text-attn/80">
                Skapa dem som egna konton, eller kontrollera inmatningen.
              </p>
              {onCreateUnknown && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {unknownRows.map((r) => (
                    <Button
                      key={r.account_number}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => onCreateUnknown(r.account_number)}
                    >
                      <Plus className="mr-1 h-3 w-3" />
                      Skapa <span data-ph-mask="">{r.account_number}</span>
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Avbryt
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Aktiverar...
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                {confirmLabel ?? 'Aktivera och bokför'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
