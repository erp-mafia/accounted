'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { stageSkvManualPrefill } from '@/lib/skatteverket/manual-verifikat-prefill'
import { readSkattekontoTwinProbe } from '@/lib/skatteverket/skattekonto-twin-probe'
import type { SkattekontoLedgerAccount } from '@/lib/skatteverket/skattekonto-account'
import { SkattekontoLinkProposalsDialog } from './SkattekontoLinkProposalsDialog'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import type {
  SkattekontoBatchResult,
  SkattekontoBatchRowResult,
  SkattekontoBookingSuggestion,
  SkattekontoLedgerCoverInfo,
  SkattekontoLedgerTwin,
  SkattekontoTransactionWithSuggestion,
} from '@/types/skatteverket'

/** How long the on-open twin probe may hold the confirm before it counts as failed. */
const TWIN_PROBE_TIMEOUT_MS = 8000

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
 * per-row override for an event that really happened twice, once the user
 * has written why (the verifikat notes carry the reason). A row
 * Skatteverket has not settled yet cannot be linked, so there the primary
 * action is to wait. "Skapa manuellt" asks the same candidate search first
 * (match-candidates) and shows the same answer.
 *
 * LEDGER_COVER_EXISTS is the same answer for a row no single verifikat
 * carries, but that unlinked verifikat on 1630 already hold in aggregate (a
 * summarised year-end or month-end verifikat, crm#1043): the covering
 * verifikat are listed, the primary action opens the one-action link of
 * every row a verifikat already holds (SkattekontoLinkProposalsDialog,
 * PH 171), which falls back to "Matcha manuellt" for what no proposal
 * covers, and "Bokför ändå" repeats the booking with the same per-row
 * override. "Skapa manuellt" gets the same answer from the candidate search
 * (ledger_cover).
 *
 * LEDGER_DIRECT_EXISTS is the answer for a row whose event a bank verifikat
 * without any line on the skattekonto account already books (PH 171): the
 * previous system, or a bank line here, paid the tax straight to the tax
 * accounts. There is nothing to link (no skattekonto line), so the primary
 * action ignores the row, and "Bokför ändå" books it with the same per-row
 * override.
 *
 * The dialog also asks that search as soon as it opens, so a row whose event
 * is already in the ledger opens on the twin answer instead of on a
 * confident "1630 mot 1930" proposal with an immutable-verifikat warning.
 * The server refusal stays the guard; the probe only stops the dialog from
 * offering a booking it would refuse.
 */

/** The receivable a rot/rut payout clears (1513 in the SE pack). */
const ROT_RUT_RECEIVABLE = resolveAccountRole(PINNED_JURISDICTION, 'rot_rut_receivable')

/**
 * The accounts a rot/rut set-off booked as its begäran's payout credits
 * (buildRotRutPayoutLines): 1513 for any part already on it, then the
 * share's revenue and moms.
 */
function payoutCreditAccounts(leg: NonNullable<SkattekontoBookingSuggestion['rot_rut_payout']>['leg']): string[] {
  const recognised = leg.recognition?.amount ?? 0
  const accounts = roundOre(leg.amount - recognised) > 0 ? [ROT_RUT_RECEIVABLE] : []
  for (const line of leg.recognition?.lines ?? []) {
    if (!accounts.includes(line.account_number)) accounts.push(line.account_number)
  }
  return accounts
}

export default function SkattekontoBookDialog({
  row,
  open,
  onOpenChange,
  onBooked,
  onMatch,
  onLinkCovered,
  skattekontoAccount,
  onLinked,
}: {
  row: SkattekontoTransactionWithSuggestion | null
  /** The company's skattekonto account (1630, or 2012), as the server reported it. */
  skattekontoAccount: SkattekontoLedgerAccount
  open: boolean
  onOpenChange: (open: boolean) => void
  onBooked: (rowId: string, result: SkattekontoBatchRowResult) => void
  // Opens the existing "Matcha mot verifikat" flow for this row; the dialog
  // closes itself first. Optional: callers without a match flow fall back to
  // manual verifikat creation only.
  onMatch?: () => void
  // Opens the manual match view for a row a summarised verifikat covers; the
  // dialog closes itself first. Omitted: the dialog navigates there itself.
  onLinkCovered?: () => void
  // Rows were linked (or the link undone) from the cover answer, or ignored
  // from the direct answer: reload them.
  onLinked?: () => void
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

  // The ledger-cover refusal for the row it was given for, and which action
  // "Bokför ändå" repeats.
  const [coverRefusal, setCoverRefusal] = useState<{
    rowId: string
    cover: SkattekontoLedgerCoverInfo | null
    mode: 'book' | 'draft' | 'manual'
  } | null>(null)
  // The direct-booking refusal (PH 171) for the row it was given for, and
  // which action "Bokför ändå" repeats.
  const [directRefusal, setDirectRefusal] = useState<{
    rowId: string
    holders: SkattekontoLedgerTwin[]
    mode: 'book' | 'draft'
  } | null>(null)
  const [isIgnoring, setIsIgnoring] = useState(false)
  // The cover answer's "Koppla händelserna" swaps this dialog for the bulk link.
  const [linkAllFor, setLinkAllFor] = useState<string | null>(null)
  // "Bokför ändå" asks why first: the reason is the override, and the
  // verifikat carries it. Shown once the user chose to book anyway.
  const [anywayReason, setAnywayReason] = useState<{ rowId: string; text: string } | null>(null)
  // The row id the on-open twin probe is running for.
  const [probingRowId, setProbingRowId] = useState<string | null>(null)

  const rowId = row?.id ?? null
  // Which action "Bokför ändå" repeats for a twin found on open: the one the
  // dialog's primary button would have taken.
  const openMode: 'book' | 'draft' | 'manual' =
    row?.booking_suggestion != null ? 'book' : row?.booking_suggestion === null ? 'manual' : 'draft'

  useEffect(() => {
    if (!open || !rowId) return
    let cancelled = false
    // A hung probe must not hold the confirm forever: past the timeout it
    // counts as failed, which leaves the ordinary dialog.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TWIN_PROBE_TIMEOUT_MS)
    setProbingRowId(rowId)
    void (async () => {
      try {
        const res = await fetch(
          `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${rowId}/match-candidates`,
          { signal: controller.signal },
        )
        const answer = readSkattekontoTwinProbe(res.ok ? await res.json() : null)
        if (cancelled || !answer) return
        // A summarised verifikat that already holds the row is the same
        // answer as a twin: the server would refuse with LEDGER_COVER_EXISTS.
        if (answer.kind === 'twin') setTwinRefusal({ rowId, twins: answer.twins, mode: openMode })
        else setCoverRefusal({ rowId, cover: answer.cover, mode: openMode })
      } catch {
        // A failed or timed-out probe leaves the ordinary dialog; the server still refuses a twin.
      } finally {
        clearTimeout(timer)
        if (!cancelled) setProbingRowId(null)
      }
    })()
    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
      // Closing mid-probe must not leave the row marked as probing.
      setProbingRowId((current) => (current === rowId ? null : current))
    }
  }, [open, rowId, openMode])

  if (!row) return null
  const isProbing = probingRowId === row.id
  const twinState = twinRefusal?.rowId === row.id ? twinRefusal : null
  const coverState = coverRefusal?.rowId === row.id ? coverRefusal : null
  const directState = directRefusal?.rowId === row.id ? directRefusal : null
  const reasonState = anywayReason?.rowId === row.id ? anywayReason : null
  const reasonText = reasonState?.text.trim() ?? ''

  // Closing forgets the refusal: a reopened dialog asks the server again.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setTwinRefusal(null)
      setCoverRefusal(null)
      setDirectRefusal(null)
      setLinkAllFor(null)
      setAnywayReason(null)
    }
    onOpenChange(next)
  }

  const amount = Number(row.belopp_skatteverket)
  const suggestion = row.booking_suggestion
  const canBookDirectly = suggestion != null
  // null (not undefined) means the rules were evaluated and none matched:
  // the draft endpoint would be a guaranteed 422 (NO_COUNTER_ACCOUNT).
  const noRuleMatched = suggestion === null

  // duplicateReason: the override, book although the ledger holds the event.
  async function handleBook(duplicateReason: string | null) {
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
            ...(duplicateReason ? { allow_duplicate_ids: [row.id], duplicate_reason: duplicateReason } : {}),
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
      if (result.error_code === 'LEDGER_COVER_EXISTS') {
        setCoverRefusal({ rowId: row.id, cover: result.ledger_cover ?? null, mode: 'book' })
        return
      }
      if (result.error_code === 'LEDGER_DIRECT_EXISTS') {
        setDirectRefusal({ rowId: row.id, holders: result.ledger_direct ?? [], mode: 'book' })
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

  async function handleOpenDraft(duplicateReason: string | null) {
    if (!row) return
    setIsOpeningDraft(true)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${row.id}/bokfor`,
        duplicateReason
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ allow_duplicate: true, duplicate_reason: duplicateReason }),
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
      if (!res.ok && json?.code === 'LEDGER_COVER_EXISTS') {
        setCoverRefusal({
          rowId: row.id,
          cover: (json.ledger_cover as SkattekontoLedgerCoverInfo | undefined) ?? null,
          mode: 'draft',
        })
        return
      }
      if (!res.ok && json?.code === 'LEDGER_DIRECT_EXISTS') {
        setDirectRefusal({
          rowId: row.id,
          holders: Array.isArray(json.ledger_direct) ? (json.ledger_direct as SkattekontoLedgerTwin[]) : [],
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

  // The direct answer's primary action: the event is already in the books,
  // so the row needs no verifikat of its own. Ignoring is reversible (the
  // ignored rows can be restored on the lists).
  async function handleIgnoreInstead() {
    if (!row) return
    setIsIgnoring(true)
    try {
      const res = await fetch(`/api/extensions/ext/skatteverket/skattekonto/transaktioner/${row.id}/ignore`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_ignored: true }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({
          title: t('direct_ignore_failed'),
          description: getErrorMessage(json, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('direct_ignored_title'), description: t('direct_ignored_description') })
      handleOpenChange(false)
      onLinked?.()
    } catch (err) {
      toast({
        title: t('direct_ignore_failed'),
        description: err instanceof Error ? getErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsIgnoring(false)
    }
  }

  // "Bokför ändå" (or "Öppna som utkast ändå"): the first press asks why,
  // the second books with that reason. "Skapa manuellt ändå" opens the
  // manual form, where the user writes the verifikat themselves.
  function bookAnywayFor(mode: 'book' | 'draft' | 'manual') {
    if (!row) return
    if (mode === 'manual') {
      void handleManualCreate(true)
      return
    }
    if (!reasonState) {
      setAnywayReason({ rowId: row.id, text: '' })
      return
    }
    if (!reasonText) return
    if (mode === 'book') void handleBook(reasonText)
    else void handleOpenDraft(reasonText)
  }

  function handleBookAnyway() {
    if (twinState) bookAnywayFor(twinState.mode)
  }

  // Disabled while the reason is still empty: the override needs one.
  const anywayBlocked = (mode: 'book' | 'draft' | 'manual') => mode !== 'manual' && reasonState !== null && !reasonText

  const reasonField = reasonState ? (
    <div className="space-y-1.5">
      <Label htmlFor="skv-book-anyway-reason">{t('anyway_reason_label')}</Label>
      <Textarea
        id="skv-book-anyway-reason"
        value={reasonState.text}
        onChange={(e) => setAnywayReason({ rowId: reasonState.rowId, text: e.target.value })}
        maxLength={500}
        rows={2}
        autoFocus
        data-ph-mask
      />
      <p className="text-xs leading-5 text-muted-foreground">{t('anyway_reason_hint')}</p>
    </div>
  ) : null

  if (coverState && linkAllFor === row.id) {
    return (
      <SkattekontoLinkProposalsDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) handleOpenChange(false)
        }}
        onLinked={onLinked}
        focusRowId={row.id}
        onManual={onLinkCovered}
        skattekontoAccount={skattekontoAccount}
      />
    )
  }

  if (directState) {
    const submitting = isBooking || isOpeningDraft || isIgnoring
    return (
      <ConfirmationDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={t('direct_title')}
        help={t('direct_hint', { skattekonto: skattekontoAccount })}
        isSubmitting={submitting}
        confirmLabel={t('direct_ignore_cta')}
        // The override records the event a second time: say so.
        warningText={t('direct_warning')}
        onConfirm={() => void handleIgnoreInstead()}
        extraActions={
          <Button
            variant="ghost"
            onClick={() => bookAnywayFor(directState.mode)}
            disabled={submitting || anywayBlocked(directState.mode)}
            loading={isBooking || isOpeningDraft}
            className="w-full sm:w-auto text-muted-foreground"
          >
            {t('twin_book_anyway')}
          </Button>
        }
      >
        <div className="space-y-3 py-2 text-sm">
          <p className="leading-6">
            {t('direct_body', {
              text: row.transaktionstext,
              amount: formatCurrency(Math.abs(amount)),
              date: formatDate(row.transaktionsdatum),
              skattekonto: skattekontoAccount,
            })}
          </p>
          {directState.holders.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {directState.holders.slice(0, 5).map((entry) => (
                <li
                  key={entry.journal_entry_id}
                  className="flex items-baseline justify-between gap-4 px-3 py-2"
                >
                  <span className="shrink-0 tabular-nums font-medium">
                    {entry.voucher_number ? formatVoucher(entry) : t('twin_draft')}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" data-ph-mask>
                    {entry.description}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatDate(entry.entry_date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {reasonField}
        </div>
      </ConfirmationDialog>
    )
  }

  if (coverState) {
    const cover = coverState.cover
    const submitting = isBooking || isOpeningDraft
    const bookAnyway = () => bookAnywayFor(coverState.mode)
    return (
      <ConfirmationDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={t('cover_title')}
        help={t('cover_hint')}
        isSubmitting={submitting}
        confirmLabel={t('cover_link_cta')}
        // The override records the event a second time: say so.
        warningText={t('cover_warning', { skattekonto: skattekontoAccount })}
        onConfirm={() => setLinkAllFor(row.id)}
        extraActions={
          <Button
            variant="ghost"
            onClick={bookAnyway}
            disabled={submitting || anywayBlocked(coverState.mode)}
            loading={submitting}
            className="w-full sm:w-auto text-muted-foreground"
          >
            {coverState.mode === 'manual' ? t('twin_manual_anyway') : t('twin_book_anyway')}
          </Button>
        }
      >
        <div className="space-y-3 py-2 text-sm">
          <p className="leading-6">
            {cover
              ? cover.kind === 'planned_link'
                ? t('cover_body_planned', {
                    others: cover.event_count - 1,
                    total: formatCurrency(cover.event_total),
                    skattekonto: skattekontoAccount,
                  })
                : t(cover.kind === 'events_equal' ? 'cover_body_equal' : 'cover_body_agrees', {
                    count: cover.event_count,
                    total: formatCurrency(cover.event_total),
                    date: formatDate(cover.through_date),
                    skattekonto: skattekontoAccount,
                  })
              : t('cover_body_plain', { skattekonto: skattekontoAccount })}
          </p>
          {cover && cover.entries.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {cover.entries.map((entry) => (
                <li
                  key={entry.journal_entry_id}
                  className="flex items-baseline justify-between gap-4 px-3 py-2"
                >
                  <span className="shrink-0 tabular-nums font-medium">
                    {entry.voucher_number ? formatVoucher(entry) : t('twin_draft')}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" data-ph-mask>
                    {entry.description}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground" data-ph-mask>
                    {formatCurrency(entry.open_amount)}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatDate(entry.entry_date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {reasonField}
        </div>
      </ConfirmationDialog>
    )
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
        help={t('twin_hint')}
        isSubmitting={isBooking || isOpeningDraft}
        confirmLabel={
          primary === 'match' ? t('twin_match_cta') : primary === 'wait' ? t('twin_wait_cta') : anywayLabel
        }
        // The override records the event a second time: say so whichever
        // button carries it.
        warningText={t('twin_warning', { skattekonto: skattekontoAccount })}
        onConfirm={
          primary === 'match'
            ? handleMatchInstead
            : primary === 'wait'
              ? () => handleOpenChange(false)
              : handleBookAnyway
        }
        confirmDisabled={primary === 'anyway' && anywayBlocked(twinState.mode)}
        extraActions={
          primary !== 'anyway' ? (
            <Button
              variant="ghost"
              onClick={handleBookAnyway}
              disabled={isBooking || isOpeningDraft || anywayBlocked(twinState.mode)}
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
              skattekonto: skattekontoAccount,
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
          {reasonField}
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
        const answer = readSkattekontoTwinProbe(res.ok ? await res.json() : null)
        if (answer?.kind === 'twin') {
          setTwinRefusal({ rowId: row.id, twins: answer.twins, mode: 'manual' })
          return
        }
        // No verifikat carries the row exactly, but a summarised one may
        // already hold it: the same answer as the booking guard gives.
        if (answer?.kind === 'cover') {
          setCoverRefusal({ rowId: row.id, cover: answer.cover, mode: 'manual' })
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
    // form opens prefilled (skattekonto account + counter line) and the created verifikat is
    // auto-linked back to this skattekonto row via the match endpoint. Plain
    // '/bookkeeping' here was a dead end: the user landed on the list with no
    // form, no prefill and no link.
    handleOpenChange(false)
    router.push(stageSkvManualPrefill(row, skattekontoAccount))
  }

  return (
    <ConfirmationDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('title')}
      isSubmitting={isBooking || isOpeningDraft}
      // Held until the on-open twin probe has answered: a click before then
      // would only reach the server refusal the probe is about to show.
      confirmDisabled={isProbing}
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
          ? () => void handleBook(null)
          : noRuleMatched
            ? onMatch
              ? handleMatchInstead
              : () => void handleManualCreate(false)
            : () => void handleOpenDraft(null)
      }
      extraActions={
        canBookDirectly ? (
          <Button
            variant="ghost"
            onClick={() => void handleOpenDraft(null)}
            disabled={isBooking || isProbing}
            loading={isOpeningDraft}
            className="w-full sm:w-auto text-muted-foreground"
          >
            {t('open_draft')}
          </Button>
        ) : noRuleMatched && onMatch ? (
          <Button
            variant="ghost"
            onClick={() => void handleManualCreate(false)}
            disabled={isBooking || isOpeningDraft || isProbing}
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
                skattekonto: skattekontoAccount,
                account: suggestion.rot_rut_payout
                  ? payoutCreditAccounts(suggestion.rot_rut_payout.leg).join(', ')
                  : suggestion.account_name
                    ? `${suggestion.account} ${suggestion.account_name}`
                    : suggestion.account,
              })}
              {suggestion.rot_rut_payout ? (
                <span className="block text-xs text-muted-foreground">
                  {t('posting_rot_rut_payout', { name: suggestion.rot_rut_payout.request_name })}
                </span>
              ) : null}
              {suggestion.ore_rounding ? (
                <span className="block text-xs text-muted-foreground">
                  {t('posting_rounding', {
                    receivable: formatCurrency(roundOre(Math.abs(amount) - suggestion.ore_rounding)),
                    difference: formatCurrency(Math.abs(suggestion.ore_rounding)),
                  })}
                </span>
              ) : null}
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
