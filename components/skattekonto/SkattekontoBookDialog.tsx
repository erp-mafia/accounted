'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { stageSkvManualPrefill } from '@/lib/skatteverket/manual-verifikat-prefill'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { Loader2 } from 'lucide-react'
import type {
  SkattekontoBatchResult,
  SkattekontoBatchRowResult,
  SkattekontoTransactionWithSuggestion,
} from '@/types/skatteverket'

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

  if (!row) return null

  const amount = Number(row.belopp_skatteverket)
  const suggestion = row.booking_suggestion
  const canBookDirectly = suggestion != null
  // null (not undefined) means the rules were evaluated and none matched:
  // the draft endpoint would be a guaranteed 422 (NO_COUNTER_ACCOUNT).
  const noRuleMatched = suggestion === null

  async function handleBook() {
    if (!row) return
    setIsBooking(true)
    try {
      const res = await fetch(
        '/api/extensions/ext/skatteverket/skattekonto/transaktioner/bokfor-batch',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [row.id] }),
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
        onOpenChange(false)
        onBooked(row.id, result)
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
        onOpenChange(false)
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

  async function handleOpenDraft() {
    if (!row) return
    setIsOpeningDraft(true)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${row.id}/bokfor`,
        { method: 'POST' },
      )
      const json = await res.json()
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
      onOpenChange(false)
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
    onOpenChange(false)
    onMatch?.()
  }

  function handleManualCreate() {
    if (!row) return
    // Deep-link into /bookkeeping's Nytt verifikat dialog: the row payload is
    // staged in sessionStorage (only the opaque id rides in the URL) so the
    // form opens prefilled (1630 + counter line) and the created verifikat is
    // auto-linked back to this skattekonto row via the match endpoint. Plain
    // '/bookkeeping' here was a dead end: the user landed on the list with no
    // form, no prefill and no link.
    onOpenChange(false)
    router.push(stageSkvManualPrefill(row))
  }

  return (
    <ConfirmationDialog
      open={open}
      onOpenChange={onOpenChange}
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
          ? handleBook
          : noRuleMatched
            ? onMatch
              ? handleMatchInstead
              : handleManualCreate
            : handleOpenDraft
      }
      extraActions={
        canBookDirectly ? (
          <Button
            variant="ghost"
            onClick={handleOpenDraft}
            disabled={isBooking || isOpeningDraft}
            className="min-h-11 w-full sm:w-auto text-muted-foreground"
          >
            {isOpeningDraft && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('open_draft')}
          </Button>
        ) : noRuleMatched && onMatch ? (
          <Button
            variant="ghost"
            onClick={handleManualCreate}
            disabled={isBooking || isOpeningDraft}
            className="min-h-11 w-full sm:w-auto text-muted-foreground"
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
