'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'
import { daysBetween } from '@/lib/company/fiscal-year'
import type { StoredAccount } from '../types'

export interface SyncProgressSummary {
  imported: number
  duplicates: number
  requested_from: string
  returned_min_date: string | null
  returned_max_date: string | null
}

export interface SyncProgressError {
  message: string
}

export type SyncProgressState =
  | { kind: 'syncing' }
  | { kind: 'done'; summary: SyncProgressSummary }
  | { kind: 'failed'; error: SyncProgressError }

interface BankSyncProgressDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  bankName: string
  accounts: StoredAccount[]
  state: SyncProgressState
}

// Past this point the sync has run longer than the promised "up to a minute".
// We stop hard-locking the modal so the user isn't trapped: the request keeps
// running server-side (idempotent) and completion still resolves the state.
const GRACE_SEC = 75

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
}

export function BankSyncProgressDialog({
  open,
  onOpenChange,
  bankName,
  accounts,
  state,
}: BankSyncProgressDialogProps) {
  const enabledAccounts = accounts.filter((a) => a.enabled !== false)

  // Tick a visible elapsed counter while syncing so a slow bank doesn't look
  // frozen, and so we know when to release the close-lock (GRACE_SEC). State is
  // only ever set from the timer callbacks (never synchronously in the effect
  // body), and elapsed is never computed from Date.now() during render, so this
  // stays clear of the react-hooks purity rules.
  const [elapsedSec, setElapsedSec] = useState(0)
  useEffect(() => {
    if (!open || state.kind !== 'syncing') return
    const started = Date.now()
    const tick = () => setElapsedSec(Math.max(0, Math.floor((Date.now() - started) / 1000)))
    // Reset to ~0 on the next tick (async, so not a synchronous effect setState).
    const reset = setTimeout(tick, 0)
    const id = setInterval(tick, 1000)
    return () => {
      clearTimeout(reset)
      clearInterval(id)
    }
  }, [open, state.kind])

  const overGrace = state.kind === 'syncing' && elapsedSec >= GRACE_SEC
  // Only hard-block the close affordances during the expected window; after the
  // grace period the user may background the (still-running) sync.
  const blockClose = state.kind === 'syncing' && !overGrace

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && blockClose) return
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="max-w-md"
        onPointerDownOutside={(e) => {
          if (blockClose) e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          if (blockClose) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {state.kind === 'syncing' && `Hämtar transaktioner från ${bankName}`}
            {state.kind === 'done' && 'Klart'}
            {state.kind === 'failed' && 'Synkningen misslyckades'}
          </DialogTitle>
          <DialogDescription>
            {state.kind === 'syncing' && (
              overGrace ? (
                <>
                  Det tar längre tid än vanligt. Vi fortsätter i bakgrunden: du kan
                  stänga rutan och komma tillbaka senare.
                </>
              ) : (
                <>
                  Vi hämtar transaktioner från {enabledAccounts.length}{' '}
                  {enabledAccounts.length === 1 ? 'konto' : 'konton'}. Detta kan ta upp till en minut. Stäng inte fönstret.
                </>
              )
            )}
            {state.kind === 'done' && (
              <>
                Vi hämtade {state.summary.imported}{' '}
                {state.summary.imported === 1 ? 'transaktion' : 'transaktioner'}.
              </>
            )}
            {state.kind === 'failed' && (
              <>Vi försöker igen automatiskt i bakgrunden. Du kan stänga den här rutan.</>
            )}
          </DialogDescription>
        </DialogHeader>

        {state.kind === 'syncing' && (
          <div className="space-y-3 py-2">
            <div className="flex flex-col items-center justify-center gap-2 py-6">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
                {formatElapsed(elapsedSec)}
              </span>
            </div>
            <ul className="rounded-lg border border-border divide-y divide-border text-sm">
              {enabledAccounts.map((a) => (
                <li key={a.uid} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="truncate">{a.name || a.iban || a.uid}</span>
                  <span className="text-xs text-muted-foreground">{a.currency}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {state.kind === 'done' && (
          <DoneBody summary={state.summary} />
        )}

        {state.kind === 'failed' && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            {state.error.message}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={blockClose}
          >
            {state.kind === 'syncing'
              ? (overGrace ? 'Fortsätt i bakgrunden' : 'Hämtar…')
              : 'Klar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DoneBody({ summary }: { summary: SyncProgressSummary }) {
  const requestedDays = daysBetween(summary.requested_from)
  const returnedDays =
    summary.returned_min_date && summary.returned_max_date
      ? daysBetween(summary.returned_min_date, new Date(summary.returned_max_date))
      : 0
  const wasTruncated = requestedDays - returnedDays > 7

  return (
    <div className="space-y-3 py-2">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-4">
        <CheckCircle2 className="h-6 w-6 shrink-0 text-foreground" />
        <div className="text-sm">
          <p>
            <span className="tabular-nums font-medium">{summary.imported}</span> nya transaktioner
            importerade.
          </p>
          {summary.returned_min_date && summary.returned_max_date && (
            <p className="text-xs text-muted-foreground">
              Datum: {summary.returned_min_date} → {summary.returned_max_date}
            </p>
          )}
        </div>
      </div>

      {wasTruncated && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Banken returnerade kortare historik än begärt. För äldre data, använd{' '}
            <Link href="/import?mode=sie" className="text-foreground underline underline-offset-2">
              SIE- eller bankfil-import
            </Link>
            .
          </span>
        </div>
      )}
    </div>
  )
}
