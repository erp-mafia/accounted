'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { AlertTriangle } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getBasLoadedByNumber } from '@/lib/bookkeeping/bas-lazy'
import { useBasReference } from '@/lib/bookkeeping/use-bas-reference'
import OpeningBalanceRowEditor, {
  type EditableRow,
  type OpeningBalanceEditorState,
} from '@/components/import/OpeningBalanceRowEditor'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import type { JournalEntry, JournalEntryLine } from '@/types'

interface Props {
  /** The currently-linked, posted opening-balance verifikat being corrected. */
  entry: JournalEntry
  open: boolean
  onOpenChange: (open: boolean) => void
  onCorrected: () => void
}

interface CascadeSummary {
  corrected: Array<{ fiscal_period_id: string; period_name: string | null }>
  skipped: Array<{ fiscal_period_id: string; period_name: string | null; reason: string }>
}

/** Error codes where the year itself blocks the correction: guide the user
 * to the earliest open year instead of leaving them at a dead end. */
const BLOCKED_PERIOD_CODES = new Set([
  'OB_PERIOD_CLOSED',
  'OB_PERIOD_LOCKED',
  'OB_COMPANY_LOCK_DATE',
  'OB_CORRECT_YEAR_END_EXISTS',
])

let seedIdCounter = 0

// Map the booked IB's lines into editable rows. account_name isn't stored on
// the line, so resolve it from BAS for display (cosmetic: only account_number
// + amounts are sent on save). The chart is a lazily loaded chunk: the
// caller re-seeds once it has arrived.
function seedRowsFromEntry(entry: JournalEntry): EditableRow[] {
  const lines = ((entry.lines || []) as JournalEntryLine[])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)

  return lines.map((l) => {
    const bas = getBasLoadedByNumber(l.account_number)
    return {
      id: l.id || `seed_${++seedIdCounter}`,
      account_number: l.account_number,
      account_name: bas?.account_name ?? '',
      debit_amount: Number(l.debit_amount) || 0,
      credit_amount: Number(l.credit_amount) || 0,
      validation_errors: [],
      bas_match: bas?.account_name ?? null,
    }
  })
}

/**
 * Inline correction of an already-booked opening-balance verifikat. The user
 * edits the IB's lines directly; on save we POST to
 * /api/import/opening-balance/correct, which (BFL-compliant) stornoes the old
 * IB, books a corrected one, and relinks the period to it. Works regardless of
 * how the IB was created (SIE import, CSV/Excel import, or year-end carry).
 *
 * SIE migrations book one IB verifikat per imported year, so later years'
 * saldon build on this one. When later years have their own IB verifikat the
 * dialog offers to cascade the same change to them (checked by default); the
 * server skips years that are locked, closed, or have a bokslut.
 */
export default function CorrectOpeningBalanceDialog({
  entry,
  open,
  onOpenChange,
  onCorrected,
}: Props) {
  const { toast } = useToast()
  const basReady = useBasReference()
  // basReady is a re-seed trigger: names fill in once the chart chunk lands.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialRows = useMemo(() => seedRowsFromEntry(entry), [entry, basReady])
  const [state, setState] = useState<OpeningBalanceEditorState | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [cascade, setCascade] = useState(true)
  const [showBlockedGuidance, setShowBlockedGuidance] = useState(false)

  // Shared reference cache: drives the later-years checkbox and the
  // blocked-year guidance. Best-effort: the dialog works while it loads
  // (the server remains the authority on what is correctable).
  const { periods } = useFiscalPeriods()

  // A fresh open starts without the server-refusal guidance from a prior try.
  useEffect(() => {
    if (open) setShowBlockedGuidance(false)
  }, [open])

  const currentPeriod = useMemo(
    () => periods.find((p) => p.id === entry.fiscal_period_id) ?? null,
    [periods, entry.fiscal_period_id],
  )

  /** Later years with their own linked IB verifikat: the cascade targets. */
  const laterPeriodsWithIB = useMemo(() => {
    if (!currentPeriod) return []
    return periods
      .filter(
        (p) =>
          p.period_start > currentPeriod.period_start && p.opening_balance_entry_id !== null,
      )
      .sort((a, b) => a.period_start.localeCompare(b.period_start))
  }, [periods, currentPeriod])

  /** Earliest year that still accepts corrections: the guidance target when
   * this year is locked. Client-side approximation; the server re-checks. */
  const earliestOpenPeriod = useMemo(() => {
    return (
      [...periods]
        .sort((a, b) => a.period_start.localeCompare(b.period_start))
        .find((p) => !p.is_closed && !p.locked_at && p.opening_balance_entry_id !== null) ?? null
    )
  }, [periods])

  const currentPeriodBlocked =
    currentPeriod !== null && (currentPeriod.is_closed || currentPeriod.locked_at !== null)

  const guidancePeriod =
    earliestOpenPeriod && earliestOpenPeriod.id !== entry.fiscal_period_id
      ? earliestOpenPeriod
      : null

  const handleSubmit = useCallback(async () => {
    if (!state?.canSubmit || isSubmitting) return

    setIsSubmitting(true)
    try {
      const lines = state.rows
        .filter((r) => r.debit_amount > 0 || r.credit_amount > 0)
        .map((r) => ({
          account_number: r.account_number,
          debit_amount: r.debit_amount,
          credit_amount: r.credit_amount,
        }))

      const res = await fetch('/api/import/opening-balance/correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // cascade is ALWAYS sent (default on): if the reference cache has not
        // loaded yet the checkbox is simply not shown, and omitting the flag
        // in that window would silently leave later years stale. The server
        // returns an empty cascade result when no later period exists.
        body: JSON.stringify({
          fiscal_period_id: entry.fiscal_period_id,
          lines,
          cascade,
        }),
      })

      const result = await res.json()

      if (!res.ok) {
        const err = new Error('Failed to correct opening balances') as Error & {
          body?: unknown
          status?: number
        }
        err.body = result
        err.status = res.status
        throw err
      }

      const cascadeSummary = (result?.data?.cascade ?? null) as CascadeSummary | null
      let description = 'Den gamla IB-verifikationen stornades och en ny bokfördes.'
      if (cascadeSummary) {
        const done = cascadeSummary.corrected.length
        // Blocked (locked/closed/bokslut) and failed skips are different
        // situations for the user: blocked is expected and needs no action
        // here; failed means the year was left untouched and needs a look.
        const blocked = cascadeSummary.skipped.filter(
          (s) => s.reason === 'closed' || s.reason === 'locked' || s.reason === 'lock_date' || s.reason === 'year_end',
        )
        const failed = cascadeSummary.skipped.filter(
          (s) => s.reason === 'correction_failed' || s.reason === 'validation_failed',
        )
        if (done > 0) {
          description += ` ${done} senare räkenskapsår uppdaterades också.`
        }
        if (blocked.length > 0) {
          const names = blocked.map((s) => s.period_name).filter(Boolean).join(', ')
          description += ` ${blocked.length} år hoppades över (låsta, stängda eller med bokslut)${names ? `: ${names}` : ''}.`
        }
        if (failed.length > 0) {
          const names = failed.map((s) => s.period_name).filter(Boolean).join(', ')
          description += ` ${failed.length} år kunde inte uppdateras och behöver kontrolleras${names ? `: ${names}` : ''}.`
        }
      }

      toast({ title: 'Ingående balanser korrigerade', description })
      // The correction relinks fiscal_periods.opening_balance_entry_id (for
      // every cascaded year too): refresh the shared reference cache.
      await invalidateReferenceData('ref:fiscal-periods')
      onOpenChange(false)
      onCorrected()
    } catch (err) {
      const anyErr = err as { body?: unknown; status?: number }
      const code = (anyErr.body as { error?: { code?: string } } | undefined)?.error?.code
      if (code && BLOCKED_PERIOD_CODES.has(code)) {
        setShowBlockedGuidance(true)
      }
      toast({
        title: 'Kunde inte korrigera ingående balanser',
        description: getErrorMessage(anyErr.body ?? err, {
          context: 'journal_entry',
          statusCode: anyErr.status,
        }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }, [state, isSubmitting, entry.fiscal_period_id, cascade, toast, onOpenChange, onCorrected])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Korrigera ingående balanser</DialogTitle>
          <DialogDescription>
            Ändra beloppen nedan och spara. Den befintliga IB-verifikationen (
            <span data-ph-mask="">{formatVoucher(entry)}</span>) makuleras och en ny bokförs med
            de korrigerade beloppen.
          </DialogDescription>
        </DialogHeader>

        {/* Storno explanation: a booked verifikat can't be edited in place */}
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
          <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
          <p className="text-sm text-warning">
            En bokförd verifikation kan inte ändras direkt (Bokföringslagen). När du sparar stornas
            den gamla IB-verifikationen och en ny bokförs: båda sparas som en spårbar rättelse.
          </p>
        </div>

        {/* Blocked-year guidance: shown when this year is (or the server says
            it is) locked, closed, or has a bokslut. Instead of a dead end,
            point at the earliest year that still accepts corrections. */}
        {(currentPeriodBlocked || showBlockedGuidance) && (
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-1">
            <p className="text-sm">
              Det här räkenskapsåret är låst, stängt eller har ett bokslut, så dess ingående
              balanser kan inte korrigeras här.
            </p>
            {guidancePeriod ? (
              <p className="text-sm">
                Korrigera i stället ingående balansen för{' '}
                <Link
                  href={`/bookkeeping/${guidancePeriod.opening_balance_entry_id}`}
                  className="underline underline-offset-2"
                >
                  {guidancePeriod.name || guidancePeriod.period_start.slice(0, 4)}
                </Link>
                , det tidigaste öppna året. Då blir saldona rätt framåt; tidigare år är redan
                deklarerade i ditt förra bokföringsprogram.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                För att korrigera behöver året först låsas upp (eller bokslutet återföras) under
                Bokföring → Räkenskapsår.
              </p>
            )}
          </div>
        )}

        <OpeningBalanceRowEditor initialRows={initialRows} onChange={setState} />

        {/* Cascade opt-out: later years imported from SIE carry their own IB
            verifikat with the old figures; without this they stay wrong. */}
        {laterPeriodsWithIB.length > 0 && (
          <label className="flex items-start gap-3 rounded-lg border border-border px-4 py-3 cursor-pointer">
            <Checkbox
              checked={cascade}
              onCheckedChange={(v) => setCascade(v === true)}
              className="mt-0.5"
            />
            <span className="space-y-1">
              <span className="block text-sm">
                Uppdatera även senare räkenskapsår ({laterPeriodsWithIB.length})
              </span>
              <span className="block text-sm text-muted-foreground">
                Samma ändring bokförs i senare års ingående balanser så att saldona stämmer
                framåt. År som är låsta eller har bokslut hoppas över. Avser rättelsen ett
                tidigare års resultat (t.ex. konto 2099) kan en omföring till balanserat
                resultat fortfarande behöva bokföras som vanligt.
              </span>
            </span>
          </label>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Avbryt
          </Button>
          <Button onClick={handleSubmit} disabled={!state?.canSubmit || isSubmitting}>
            {isSubmitting ? 'Sparar...' : 'Korrigera ingående balanser'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
