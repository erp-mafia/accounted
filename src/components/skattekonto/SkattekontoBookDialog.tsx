'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { stageSkvManualPrefill } from '@/lib/skatteverket/manual-verifikat-prefill'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import type {
  SkattekontoBatchResult,
  SkattekontoBatchRowResult,
  SkattekontoLedgerTwin,
  SkattekontoTransactionWithSuggestion,
} from '@/types/skatteverket'

/** The twin fields of a match-candidates candidate (it carries more). */
function toLedgerTwin(c: SkattekontoLedgerTwin): SkattekontoLedgerTwin {
  return {
    journal_entry_id: c.journal_entry_id,
    voucher_series: c.voucher_series,
    voucher_number: c.voucher_number,
    entry_date: c.entry_date,
    description: c.description,
    status: c.status,
  }
}

/**
 * Inline booking for one skattekonto row: confirm-and-post without leaving
 * the list (convention 10: confirm up front). The primary "Bokför" runs the
 * server-side draft+commit (bokfor-batch with one id) so the row lands as a
 * posted verifikat in one step; "Öppna som utkast" preserves the old
 * draft-then-review path, but with a client-side navigation instead of a
 * full reload.
 *
 * Suggestion states drive the layout:
 * - object: rule matched → direct booking is the primary action
 * - null: computed, no rule matched → the draft endpoint re-derives the same
 *   null rule and rejects with NO_COUNTER_ACCOUNT, so no draft CTA here;
 *   route to the match flow (onMatch) or manual creation in /bookkeeping
 * - undefined: not computed (kommande rows) → plain draft confirm
 *
 * When the server refuses with LEDGER_TWIN_EXISTS (a verifikat already
 * carries the event on 1630, e.g. one imported by SIE), the dialog switches
 * to that answer: the twins are listed, Koppla (the match flow) is the
 * primary action and "Bokför ändå" repeats the same booking with the
 * per-row override for an event that really happened twice. A row
 * Skatteverket has not settled yet cannot be linked, so there the primary
 * action is to wait. "Skapa manuellt" asks the same candidate search first
 * (match-candidates) and shows the same answer.
 */
export default function SkattekontoBookDialog({
  row,
  open,
  onOpenChange,
  onBooked,
  onMatch,
}: {
  row: SkattekontoTransactionWithSuggestion | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onBooked: (rowId: string, result: SkattekontoBatchRowResult) => void
  // Opens the existing "Matcha mot verifikat" flow for this row; the dialog
  // closes itself first. Optional: callers without a match flow fall back to
  // manual verifikat creation only.
  onMatch?: () => void
}) {
  const t = useTranslations('skv_book_dialog')
  const { toast } = useToast()
  const router = useRouter()
  const [isBooking, setIsBooking] = useState(false)
  const [isOpeningDraft, setIsOpeningDraft] = useState(false)
  // The ledger-twin refusal for the row it was given for, and which action
  // ("Bokför", "Öppna som utkast" or "Skapa manuellt") "Bokför ändå" repeats.
  const [twinRefusal, setTwinRefusal] = useState<{
    rowId: string
    twins: SkattekontoLedgerTwin[]
    mode: 'book' | 'draft' | 'manual'
  } | null>(null)

  if (!row) return null
  const twinState = twinRefusal?.rowId === row.id ? twinRefusal : null

  // Closing forgets the refusal: a reopened dialog asks the server again.
  function handleOpenChange(next: boolean) {
    if (!next) setTwinRefusal(null)
    onOpenChange(next)
  }

  const amount = Number(row.belopp_skatteverket)
  const suggestion = row.booking_suggestion
  const canBookDirectly = suggestion != null
  // null (not undefined) means the rules were evaluated and none matched:
  // the draft endpoint would be a guaranteed 422 (NO_COUNTER_ACCOUNT).
  const noRuleMatched = suggestion === null

  async function handleBook(allowDuplicate: boolean) {
    if (!row) return
    setIsBooking(true)
    try {
      const res = await fetch(
        '/api/extensions/ext/skatteverket/skattekonto/transaktioner/bokfor-batch',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ids: [row.id],
            ...(allowDuplicate ? { allow_duplicate_ids: [row.id] } : {}),
          }),
        },
      )
      const json = await res.json()
      if (!res.ok) {
        toast({
          title: t('book_failed'),
          description: getErrorMessage(json, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      const result = (json.data as SkattekontoBatchResult).results[0]
      if (!result) {
        toast({ title: t('book_failed'), variant: 'destructive' })
        return
      }
      if (result.ok) {
        handleOpenChange(false)
        onBooked(row.id, result)
        return
      }
      if (result.error_code === 'LEDGER_TWIN_EXISTS') {
        setTwinRefusal({ rowId: row.id, twins: result.ledger_twins ?? [], mode: 'book' })
        return
      }
      if (result.error_code === 'COMMIT_FAILED' && result.journal_entry_id) {
        // The draft exists and is linked: hand the user over to it instead
        // of leaving a half-done state behind a destructive toast.
        toast({
          title: t('commit_failed_title'),
          description: result.error_message,
          variant: 'destructive',
        })
        handleOpenChange(false)
        router.push(`/bookkeeping/${result.journal_entry_id}`)
        return
      }
      toast({
        title: t('book_failed'),
        description: result.error_message,
        variant: 'destructive',
      })
    } catch (err) {
      toast({
        title: t('book_failed'),
        description: err instanceof Error ? getErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsBooking(false)
    }
  }

  async function handleOpenDraft(allowDuplicate: boolean) {
    if (!row) return
    setIsOpeningDraft(true)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${row.id}/bokfor`,
        allowDuplicate
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ allow_duplicate: true }),
            }
          : { method: 'POST' },
      )
      const json = await res.json()
      if (!res.ok && json?.code === 'LEDGER_TWIN_EXISTS') {
        setTwinRefusal({
          rowId: row.id,
          twins: Array.isArray(json.ledger_twins) ? (json.ledger_twins as SkattekontoLedgerTwin[]) : [],
          mode: 'draft',
        })
        return
      }
      if (!res.ok) {
        // Map the parsed body plus the status, never `new Error(json.error)`:
        // the mapper would discard the route's own Swedish reason.
        toast({
          title: t('book_failed'),
          description: getErrorMessage(json, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('draft_created_title'), description: t('draft_created_description') })
      handleOpenChange(false)
      router.push(`/bookkeeping/${json.data.entry.id}`)
    } catch (err) {
      toast({
        title: t('book_failed'),
        description: err instanceof Error ? getErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsOpeningDraft(false)
    }
  }

  function handleMatchInstead() {
    handleOpenChange(false)
    onMatch?.()
  }

  function handleBookAnyway() {
    if (!twinState) return
    if (twinState.mode === 'book') void handleBook(true)
    else if (twinState.mode === 'draft') void handleOpenDraft(true)
    else void handleManualCreate(true)
  }

  if (twinState) {
    // Koppla needs a settled row (linkSkattekontoRow refuses a kommande
    // one): for an unsettled row the answer is to wait and link it once
    // Skatteverket has settled it. "Bokför ändå" is never the primary action
    // while another answer exists.
    const unsettled = row.status === 'upcoming'
    const primary: 'match' | 'wait' | 'anyway' = unsettled ? 'wait' : onMatch ? 'match' : 'anyway'
    const anywayLabel = twinState.mode === 'manual' ? t('twin_manual_anyway') : t('twin_book_anyway')
    return (
      <ConfirmationDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={t('twin_title')}
        isSubmitting={isBooking || isOpeningDraft}
        confirmLabel={
          primary === 'match' ? t('twin_match_cta') : primary === 'wait' ? t('twin_wait_cta') : anywayLabel
        }
        // The override records the event a second time: say so whichever
        // button carries it.
        warningText={t('twin_warning')}
        onConfirm={
          primary === 'match'
            ? handleMatchInstead
            : primary === 'wait'
              ? () => handleOpenChange(false)
              : handleBookAnyway
        }
        extraActions={
          primary !== 'anyway' ? (
            <Button
              variant="ghost"
              onClick={handleBookAnyway}
              disabled={isBooking || isOpeningDraft}
              loading={isBooking || isOpeningDraft}
              className="w-full sm:w-auto text-muted-foreground"
            >
              {anywayLabel}
            </Button>
          ) : undefined
        }
      >
        <div className="space-y-3 py-2 text-sm">
          <p className="leading-6">
            {t(unsettled ? 'twin_body_pending' : 'twin_body', {
              text: row.transaktionstext,
              amount: formatCurrency(Math.abs(amount)),
              date: formatDate(row.transaktionsdatum),
            })}
          </p>
          {twinState.twins.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {twinState.twins.slice(0, 5).map((twin) => (
                <li
                  key={twin.journal_entry_id}
                  className="flex items-baseline justify-between gap-4 px-3 py-2"
                >
                  <span className="shrink-0 tabular-nums font-medium">
                    {twin.voucher_number ? formatVoucher(twin) : t('twin_draft')}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" data-ph-mask>
                    {twin.description}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatDate(twin.entry_date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs leading-5 text-muted-foreground">{t('twin_hint')}</p>
        </div>
      </ConfirmationDialog>
    )
  }

  async function handleManualCreate(skipTwinCheck: boolean) {
    if (!row) return
    // A manual voucher is a booking door too, and it never reaches the
    // server's ledger-twin guard. Ask the match flow's candidate search first
    // (the guard's own definition) and answer a twin the same way: Koppla,
    // with "Skapa manuellt ändå" as the override. A failed probe does not
    // block this explicit manual path: it falls back to the old behaviour.
    if (!skipTwinCheck) {
      setIsOpeningDraft(true)
      try {
        const res = await fetch(
          `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${row.id}/match-candidates`,
        )
        const json = res.ok ? await res.json() : null
        const candidates: SkattekontoLedgerTwin[] = Array.isArray(json?.data?.candidates)
          ? json.data.candidates
          : []
        if (candidates.length > 0) {
          setTwinRefusal({ rowId: row.id, twins: candidates.map(toLedgerTwin), mode: 'manual' })
          return
        }
      } catch {
        // Probe failed: fall through to the manual form.
      } finally {
        setIsOpeningDraft(false)
      }
    }
    // Deep-link into /bookkeeping's Nytt verifikat dialog: the row payload is
    // staged in sessionStorage (only the opaque id rides in the URL) so the
    // form opens prefilled (1630 + counter line) and the created verifikat is
    // auto-linked back to this skattekonto row via the match endpoint. Plain
    // '/bookkeeping' here was a dead end: the user landed on the list with no
    // form, no prefill and no link.
    handleOpenChange(false)
    router.push(stageSkvManualPrefill(row))
  }

  return (
    <ConfirmationDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('title')}
      isSubmitting={isBooking || isOpeningDraft}
      confirmLabel={
        canBookDirectly
          ? t('confirm_book')
          : noRuleMatched
            ? onMatch
              ? t('match_cta')
              : t('manual_create_cta')
            : t('open_draft')
      }
      // A draft is still editable: the immutable-verifikat warning only
      // applies when the confirm commits directly.
      warningText={canBookDirectly ? t('commit_warning') : ''}
      onConfirm={
        canBookDirectly
          ? () => void handleBook(false)
          : noRuleMatched
            ? onMatch
              ? handleMatchInstead
              : () => void handleManualCreate(false)
            : () => void handleOpenDraft(false)
      }
      extraActions={
        canBookDirectly ? (
          <Button
            variant="ghost"
            onClick={() => void handleOpenDraft(false)}
            disabled={isBooking}
            loading={isOpeningDraft}
            className="w-full sm:w-auto text-muted-foreground"
          >
            {t('open_draft')}
          </Button>
        ) : noRuleMatched && onMatch ? (
          <Button
            variant="ghost"
            onClick={() => void handleManualCreate(false)}
            disabled={isBooking || isOpeningDraft}
            loading={isOpeningDraft}
            className="w-full sm:w-auto text-muted-foreground"
          >
            {t('manual_create_cta')}
          </Button>
        ) : undefined
      }
    >
      <dl className="space-y-3 py-2 text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="shrink-0 text-muted-foreground">{t('event_label')}</dt>
          <dd className="text-right">{row.transaktionstext}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">{t('date_label')}</dt>
          <dd className="tabular-nums">{formatDate(row.transaktionsdatum)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">{t('amount_label')}</dt>
          <dd className={cn('tabular-nums', amount > 0 && 'text-success')}>
            {amount > 0 ? '+' : ''}
            {formatCurrency(amount)}
          </dd>
        </div>
        {suggestion ? (
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{t('posting_label')}</dt>
            <dd className="text-right tabular-nums">
              {t('posting_value', {
                account: suggestion.account_name
                  ? `${suggestion.account} ${suggestion.account_name}`
                  : suggestion.account,
              })}
            </dd>
          </div>
        ) : suggestion === null ? (
          <p className="pt-1 text-xs leading-5 text-muted-foreground">
            {/* The employer gate is not "no rule matched": the rule matched,
                but this enskild firma has no registered employees, so the row
                is most likely the owner's private A-skatt. Distinct hint so
                the user knows why booking is not offered and that ignoring
                the row is fine. */}
            {row.booking_gate === 'requires_employer'
              ? t('ef_private_tax_hint')
              : t('no_rule_matched')}
          </p>
        ) : null}
      </dl>
    </ConfirmationDialog>
  )
}
