'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import {
  getErrorMessage,
  getResponseErrorMessage,
  type ErrorLocale,
} from '@/lib/errors/get-error-message'
import type { RotRutPayoutVoucherCandidate } from '@/lib/invoices/rot-rut-link-voucher'
import { cn, formatCurrency, formatDate } from '@/lib/utils'

interface RotRutLinkVoucherDialogProps {
  request: { id: string; name: string; expected: number }
  onOpenChange: (open: boolean) => void
  onLinked: () => void
}

/**
 * "Koppla befintligt verifikat": the payout is already booked (by hand), so
 * the begäran only needs to point at that verifikat. Nothing is booked here;
 * the confirmation says so before the click, not after.
 */
export default function RotRutLinkVoucherDialog({
  request,
  onOpenChange,
  onLinked,
}: RotRutLinkVoucherDialogProps) {
  const t = useTranslations('rot_rut_overview')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [candidates, setCandidates] = useState<RotRutPayoutVoucherCandidate[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`/api/rot-rut/payout-requests/${request.id}/link-voucher`)
        if (!response.ok) {
          const description = await getResponseErrorMessage(response, 'invoice', locale)
          if (cancelled) return
          toast({ title: t('link_voucher_load_failed'), description, variant: 'destructive' })
          setCandidates([])
          return
        }
        const body = (await response.json()) as { data: RotRutPayoutVoucherCandidate[] }
        if (!cancelled) setCandidates(body.data)
      } catch (error) {
        if (cancelled) return
        toast({
          title: t('link_voucher_load_failed'),
          description: getErrorMessage(error, { context: 'invoice', locale }),
          variant: 'destructive',
        })
        setCandidates([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [locale, request.id, t, toast])

  const selected = candidates?.find((c) => c.journal_entry_id === selectedId) ?? null
  const rounding = selected ? Math.round((selected.receivable_credit - request.expected) * 100) / 100 : 0

  async function link() {
    if (!selected || linking) return
    setLinking(true)
    try {
      const response = await fetch(`/api/rot-rut/payout-requests/${request.id}/link-voucher`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journal_entry_id: selected.journal_entry_id }),
      })
      if (!response.ok) {
        toast({
          title: t('link_voucher_failed'),
          description: await getResponseErrorMessage(response, 'invoice', locale),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('link_voucher_done', { name: request.name }) })
      onLinked()
    } catch (error) {
      toast({
        title: t('link_voucher_failed'),
        description: getErrorMessage(error, { context: 'invoice', locale }),
        variant: 'destructive',
      })
    } finally {
      setLinking(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('link_voucher_title')}</DialogTitle>
          <DialogDescription>
            {t('link_voucher_description', { name: request.name, amount: formatCurrency(request.expected) })}
          </DialogDescription>
        </DialogHeader>

        {candidates === null ? (
          <div className="space-y-2" role="status" aria-label={t('loading')}>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('link_voucher_empty')}</p>
        ) : (
          <div className="max-h-64 space-y-2 overflow-y-auto" role="radiogroup" aria-label={t('link_voucher_title')}>
            {candidates.map((candidate) => {
              const isSelected = candidate.journal_entry_id === selectedId
              return (
                <button
                  key={candidate.journal_entry_id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => setSelectedId(candidate.journal_entry_id)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-secondary/60',
                    isSelected && 'border-foreground',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block font-medium">
                      {candidate.voucher_series}
                      {candidate.voucher_number} · {formatDate(candidate.entry_date)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {candidate.description ?? '-'}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{formatCurrency(candidate.receivable_credit)}</span>
                </button>
              )
            })}
          </div>
        )}

        {selected && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border p-3 text-sm">
            <dt className="text-muted-foreground">{t('link_voucher_bank')}</dt>
            <dd className="text-right tabular-nums">{formatCurrency(selected.bank_amount)}</dd>
            <dt className="text-muted-foreground">{t('link_voucher_receivable')}</dt>
            <dd className="text-right tabular-nums">{formatCurrency(selected.receivable_credit)}</dd>
            <dt className="text-muted-foreground">{t('link_voucher_rounding')}</dt>
            <dd className="text-right tabular-nums">{formatCurrency(rounding)}</dd>
            <dd className="col-span-2 mt-2 text-xs text-muted-foreground">
              {t('link_voucher_no_new_entry', {
                voucher: `${selected.voucher_series}${selected.voucher_number}`,
              })}
            </dd>
          </dl>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={linking}>
            {t('link_voucher_cancel')}
          </Button>
          <Button type="button" onClick={() => void link()} disabled={!selected} loading={linking}>
            {t('link_voucher_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
