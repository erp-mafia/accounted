'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { XCircleIcon } from '@/components/icons'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { DetailSection } from '@/components/ui/detail-section'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'

interface AttestPerson {
  user_id: string
  name: string | null
  email: string | null
}

/** GET /api/supplier-invoices/:id/attestations (lib/supplier-invoices/attest-service.ts getSupplierInvoiceAttestState). */
export interface SupplierInvoiceAttestState {
  supplier_invoice_id: string
  policy: {
    enabled: boolean
    mode: 'any' | 'all'
    threshold_amount: number | null
    preparer_may_attest: boolean
    two_step_from_sek: number | null
  }
  required: boolean
  satisfied: boolean
  blocked: boolean
  approved_at: string | null
  approved_by: AttestPerson | null
  approved: AttestPerson[]
  /** Who may give a missing approval, with their attest limits (null = no limit). */
  remaining: Array<AttestPerson & { limit_sek: number | null }>
  /** The SEK total the limits are judged against; null for a foreign invoice without a rate. */
  amount_sek: number | null
  /** How many different attesters the invoice needs. */
  steps: 1 | 2
  approvals_needed: number
  /** One missing approval must come from someone whose limit covers amount_sek. */
  needs_covering: boolean
  latest_rejection: { user: AttestPerson; comment: string | null; decided_at: string } | null
  attestations: Array<{
    attestation_id: string
    user: AttestPerson
    decision: 'approved' | 'rejected'
    comment: string | null
    source: 'app' | 'email_link' | 'api' | 'mcp'
    decided_at: string
    /** The approval's place in its round under the policy; null otherwise. */
    step: number | null
  }>
  viewer: { may_approve: boolean; may_reject: boolean; reason: string | null }
}

/** The invoice's attest state; the page reads it to hand Attestera to the panel when the policy governs the invoice. */
export function useSupplierInvoiceAttest(invoiceId: string | null) {
  return useSWR<SupplierInvoiceAttestState | null>(
    invoiceId ? `/api/supplier-invoices/${invoiceId}/attestations` : null,
    async (url: string) => {
      const res = await fetch(url)
      if (!res.ok) return null
      const body = (await res.json()) as { data?: SupplierInvoiceAttestState }
      return body.data ?? null
    },
  )
}

const nameOf = (p: AttestPerson | null | undefined, fallback: string) => p?.name ?? p?.email ?? fallback

/**
 * The invoice page's attest section: who attested, who is left, the latest
 * rejection with its comment, every decision, and Neka for the people the
 * company's attest policy lets decide (Attestera stays in the page header,
 * shown only to them). Rendered when the policy governs the invoice or a
 * decision exists; otherwise the page's own Attestera button is the whole
 * story, as before the policy.
 */
export function SupplierInvoiceAttestPanel({
  state,
  onChanged,
  canWrite,
}: {
  state: SupplierInvoiceAttestState
  /** After a decision: refetch the invoice and this state. */
  onChanged: () => Promise<void> | void
  canWrite: boolean
}) {
  const t = useTranslations('supplier_invoice_attest')
  const locale = useLocale() as ErrorLocale
  const listLocale = locale === 'en' ? 'en-US' : 'sv-SE'
  const { toast } = useToast()
  const [busy, setBusy] = useState<'reject' | null>(null)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [comment, setComment] = useState('')

  if (!state.required && state.attestations.length === 0) return null

  const someone = t('someone')
  const remainingNames = state.remaining.map((p) => nameOf(p, someone)).join(', ')
  // "Anna Ek eller Bo Lind": one of them is what is missing.
  const eitherNames = new Intl.ListFormat(listLocale, { style: 'long', type: 'disjunction' }).format(
    state.remaining.map((p) => nameOf(p, someone)),
  )
  // Levels are on: two attesters from an amount, or someone left has a limit.
  const levels = state.policy.two_step_from_sek !== null || state.remaining.some((p) => p.limit_sek !== null)
  const coveringAmount = levels && state.needs_covering && state.amount_sek !== null ? formatCurrency(state.amount_sek) : null

  async function reject() {
    setBusy('reject')
    try {
      const res = await fetch(`/api/supplier-invoices/${state.supplier_invoice_id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: comment.trim() || null }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast({ title: t('reject_failed'), description: getErrorMessage(body, { statusCode: res.status, locale, context: 'supplier_invoice' }), variant: 'destructive' })
        return
      }
      toast({ title: t('rejected_done') })
      setRejectOpen(false)
      setComment('')
      await onChanged()
    } catch (error) {
      toast({ title: t('reject_failed'), description: getErrorMessage(error, { locale, context: 'supplier_invoice' }), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  /** Who is still needed under the policy, with the limit that is missing when that is what is left. */
  function waitingStatus(): string {
    if (state.policy.mode === 'all') return t('status_waiting_all', { names: remainingNames })
    if (state.steps === 2 && state.approved.length === 0) {
      return coveringAmount
        ? t('status_two_step_none_covering', { amount: coveringAmount, names: remainingNames })
        : t('status_two_step_none', { names: remainingNames })
    }
    if (state.steps === 2) {
      return coveringAmount
        ? t('status_two_step_one_covering', { amount: coveringAmount, names: eitherNames })
        : t('status_two_step_one', { names: eitherNames })
    }
    return coveringAmount
      ? t('status_waiting_covering', { amount: coveringAmount, names: eitherNames })
      : t('status_waiting_any', { names: remainingNames })
  }

  const status = state.satisfied
    ? state.approved_by
      ? t('status_attested_by', { name: nameOf(state.approved_by, someone), date: state.approved_at ? formatDate(state.approved_at) : '' })
      : t('status_attested', { date: state.approved_at ? formatDate(state.approved_at) : '' })
    : state.blocked
      ? null
      : state.required
        ? waitingStatus()
        : t('status_not_required')

  const sourceLabel = (source: SupplierInvoiceAttestState['attestations'][number]['source']) => t(`source_${source}`)
  // Attestera stays the page header's one primary action (it asks the same
  // service); Neka lives here, beside who is left, while attest is pending.
  const showReject = canWrite && state.required && state.viewer.may_reject

  return (
    <DetailSection
      kicker={t('kicker')}
      aside={
        showReject ? (
          <Button size="sm" variant="outline" onClick={() => setRejectOpen(true)} disabled={busy !== null}>
            <XCircleIcon className="mr-2 h-4 w-4" />
            {t('reject')}
          </Button>
        ) : null
      }
    >
      <div className="space-y-3 text-[13px]">
        {state.blocked ? <AttnLine>{t('blocked')}</AttnLine> : status ? <p data-ph-mask="">{status}</p> : null}
        {!state.satisfied && state.viewer.reason === 'registrant' && (
          <p className="text-[12.5px] text-muted-foreground">{t('reason_registrant')}</p>
        )}
        {!state.satisfied && state.viewer.reason === 'already_given' && (
          <p className="text-[12.5px] text-muted-foreground">{t('reason_already_given')}</p>
        )}
        {!state.satisfied && (state.viewer.reason === 'limit' || state.viewer.reason === 'key_limit') && (
          <p className="text-[12.5px] text-muted-foreground">{t(state.viewer.reason === 'limit' ? 'reason_limit' : 'reason_key_limit')}</p>
        )}
        {state.latest_rejection && !state.satisfied && (
          <p className="text-[12.5px] text-muted-foreground" data-ph-mask="">
            {state.latest_rejection.comment
              ? t('rejected_by_with_comment', {
                  name: nameOf(state.latest_rejection.user, someone),
                  date: formatDate(state.latest_rejection.decided_at),
                  comment: state.latest_rejection.comment,
                })
              : t('rejected_by', { name: nameOf(state.latest_rejection.user, someone), date: formatDate(state.latest_rejection.decided_at) })}
          </p>
        )}
        {state.attestations.length > 0 && (
          <ul className="stagger-enter" data-ph-mask="">
            {state.attestations.map((a) => (
              <li key={a.attestation_id} className="flex items-baseline justify-between gap-4 border-b border-border py-2">
                <span className="min-w-0 truncate">
                  {t(a.decision === 'approved' ? 'decision_approved' : 'decision_rejected', { name: nameOf(a.user, someone) })}
                  {a.comment ? <span className="text-muted-foreground">{` · ${a.comment}`}</span> : null}
                </span>
                <span className="shrink-0 text-[12.5px] tabular-nums text-muted-foreground">
                  {formatDate(a.decided_at)} · {sourceLabel(a.source)}
                  {a.decision === 'approved' && a.step !== null && a.step !== undefined && state.steps === 2
                    ? ` · ${t('trail_step', { step: a.step, steps: state.steps })}`
                    : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={rejectOpen} onOpenChange={(open) => (busy ? undefined : setRejectOpen(open))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('reject_title')}</DialogTitle>
            <DialogDescription>{t('reject_description')}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={1000}
            placeholder={t('reject_comment_placeholder')}
            aria-label={t('reject_comment_label')}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)} disabled={busy !== null}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void reject()} loading={busy === 'reject'}>
              {t('reject_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DetailSection>
  )
}
