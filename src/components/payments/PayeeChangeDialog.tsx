'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { creditorNameMatches } from '@/lib/payments/creditor-name-match'
import { payeeKeyGiro } from '@/lib/payments/payee-change'
import { lookupCreditorName, PaymentsClientError, type CreditorLookupResult } from './payments-client'
import { decideInvoicePayee, fetchInvoicePayee, type InvoicePayeeView } from './payee-change-client'

interface PayeeChangeDialogProps {
  supplierInvoiceId: string
  /** The view the caller already read; fetched on open otherwise. */
  initial?: InvoicePayeeView | null
  onOpenChange: (open: boolean) => void
  /** After a decision: the caller refreshes what it shows. */
  onDecided: (decision: 'confirmed' | 'rejected') => void
}

/**
 * A person decides on the bank details a supplier invoice states and the
 * supplier card does not have: approve them (covering later invoices of the
 * supplier with the same account, and by default putting them on the
 * supplier card) or reject them (payment stays held). The registered name
 * behind a giro is shown when Bankgiro Lookup is switched on. The decision is
 * the person's own: lib/payments/payee-alerts.ts decideSupplierPayee.
 */
export function PayeeChangeDialog({ supplierInvoiceId, initial = null, onOpenChange, onDecided }: PayeeChangeDialogProps) {
  const t = useTranslations('supplier_payee_change')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [view, setView] = useState<InvoicePayeeView | null>(initial)
  const [loadFailed, setLoadFailed] = useState(false)
  // "Försök igen" after a failed read bumps it.
  const [retryKey, setRetryKey] = useState(0)
  const [lookup, setLookup] = useState<CreditorLookupResult | null>(null)
  const [updateCard, setUpdateCard] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'confirmed' | 'rejected' | null>(null)

  useEffect(() => {
    if (initial) return
    let cancelled = false
    fetchInvoicePayee(supplierInvoiceId)
      .then((next) => {
        if (cancelled) return
        setView(next)
        setLoadFailed(false)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [initial, supplierInvoiceId, retryKey])

  // The name Bankgirot has registered for the new giro: advice, never a gate,
  // and nothing at all while the lookup is switched off.
  const giro = view?.new_payee_key ? payeeKeyGiro(view.new_payee_key) : null
  const giroNumber = giro?.giro ?? null
  const giroType = giro?.type ?? null
  useEffect(() => {
    if (!giroNumber || !giroType) return
    let cancelled = false
    lookupCreditorName({ giro: giroNumber, type: giroType })
      .then((answer) => {
        if (!cancelled) setLookup(answer)
      })
      .catch(() => {
        if (!cancelled) setLookup(null)
      })
    return () => {
      cancelled = true
    }
  }, [giroNumber, giroType])

  async function decide(decision: 'confirmed' | 'rejected') {
    setBusy(decision)
    try {
      await decideInvoicePayee(supplierInvoiceId, {
        decision,
        updateSupplierCard: decision === 'confirmed' ? updateCard : undefined,
        note,
      })
      toast({ title: decision === 'confirmed' ? t('confirmed_toast') : t('rejected_toast') })
      onDecided(decision)
      onOpenChange(false)
    } catch (error) {
      const body = error instanceof PaymentsClientError ? error.body : null
      toast({ title: t('decide_failed_title'), description: getErrorMessage(body, { locale }), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const registeredName = lookup?.enabled && lookup.available ? lookup.creditor_name : null

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{view ? t('title', { supplier: view.supplier_name }) : t('title_loading')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {!view ? (
          loadFailed ? (
            <LoadError
              onRetry={() => {
                setLoadFailed(false)
                setRetryKey((key) => key + 1)
              }}
            />
          ) : (
            <LateReveal className="space-y-2">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-1/2" />
            </LateReveal>
          )
        ) : (
          <div className="space-y-4 text-[13px]">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2">
              <dt className="text-muted-foreground">{t('on_card')}</dt>
              <dd className="min-w-0 break-words tabular-nums">{view.old_payee ?? t('card_empty')}</dd>
              <dt className="text-muted-foreground">{t('on_invoice')}</dt>
              <dd className="min-w-0 break-words tabular-nums">{view.new_payee}</dd>
              {registeredName && (
                <>
                  <dt className="text-muted-foreground">{t('registered_name')}</dt>
                  <dd className="min-w-0 break-words">{registeredName}</dd>
                </>
              )}
            </dl>
            {registeredName && !creditorNameMatches(registeredName, view.supplier_name) && (
              <AttnLine>{t('registered_name_differs', { name: registeredName, supplier: view.supplier_name })}</AttnLine>
            )}
            {view.decision === 'rejected' && <p className="text-muted-foreground">{t('rejected_before')}</p>}
            <p className="text-xs text-muted-foreground">{t('check_advice')}</p>
            <label className="flex items-start gap-3">
              <Checkbox checked={updateCard} onCheckedChange={(checked) => setUpdateCard(checked === true)} className="mt-0.5" />
              <span>{t('update_card')}</span>
            </label>
            <div className="space-y-1">
              <label htmlFor="payee-change-note" className="text-xs text-muted-foreground">
                {t('note_label')}
              </label>
              <Input id="payee-change-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('note_placeholder')} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => void decide('rejected')}
            loading={busy === 'rejected'}
            disabled={!view || busy !== null || view.decision === 'rejected'}
          >
            {t('reject')}
          </Button>
          <Button onClick={() => void decide('confirmed')} loading={busy === 'confirmed'} disabled={!view || busy !== null}>
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
