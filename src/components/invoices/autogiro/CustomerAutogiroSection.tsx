'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { HelpPopover } from '@/components/ui/help-popover'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { jsonRequest, requestAutogiro } from './client'
import { MANDATE_STATUS_VARIANT, type AutogiroT } from './labels'
import { useCancelMandate } from './use-cancel-mandate'
import type { AutogiroMandateRow, CustomerMandatesResponse } from './types'

/**
 * Autogiro on the customer card: the customer's mandate (payer number and
 * status, with Makulera), or "Lägg till befintligt medgivande" for a mandate
 * the customer already gave at Bankgirot (moved from another system). New
 * invoices to the customer are debited from then on. Renders nothing for a
 * company outside the rollout that holds no mandate for the customer.
 */
export function CustomerAutogiroSection({ customerId, canWrite }: { customerId: string; canWrite: boolean }) {
  const t = useTranslations('autogiro')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [state, setState] = useState<CustomerMandatesResponse | null>(null)
  const [payerNumber, setPayerNumber] = useState('')
  const [adding, setAdding] = useState(false)
  // Bumped to read the mandates again after a change; a newer read wins.
  const [reloadKey, setReloadKey] = useState(0)
  const load = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    let current = true
    void requestAutogiro<CustomerMandatesResponse>(
      `/api/invoices/autogiro/mandates?customer_id=${encodeURIComponent(customerId)}`,
      undefined,
      locale,
    ).then((result) => {
      // A failed read leaves the section out: the card works without it.
      if (current && result.ok) setState(result.data)
    })
    return () => {
      current = false
    }
  }, [customerId, locale, reloadKey])

  const { cancelMandate, dialogProps } = useCancelMandate(load)

  if (!state || (!state.enabled && state.mandates.length === 0)) return null

  const current = state.mandates.find((m) => m.status === 'active' || m.status === 'pending') ?? null
  const latest = current ?? state.mandates[0] ?? null

  async function add(event: React.FormEvent) {
    event.preventDefault()
    if (adding || !payerNumber.trim()) return
    setAdding(true)
    const result = await requestAutogiro<{ mandate: AutogiroMandateRow }>(
      '/api/invoices/autogiro/mandates',
      jsonRequest('POST', { customer_id: customerId, payer_number: payerNumber.trim() }),
      locale,
    )
    setAdding(false)
    if (!result.ok) {
      toast({ title: t('customer_add_failed'), description: result.message, variant: 'destructive' })
      return
    }
    setPayerNumber('')
    toast({ title: t('customer_added'), description: t('customer_added_description') })
    load()
  }

  return (
    <DetailSection
      kicker={t('title')}
      help={
        <HelpPopover>
          <div className="space-y-2">
            <p>{t('customer_help')}</p>
            <p>{t('help_invoice')}</p>
          </div>
        </HelpPopover>
      }
      aside={
        <Link href="/invoices/autogiro" className={QUIET_LINK_CLASS}>
          {t('customer_page_link')}
        </Link>
      }
    >
      {latest && (
        <DefRow label={t('col_payer_number')}>
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="tabular-nums">{latest.payer_number}</span>
            <MandateStatus mandate={latest} t={t} />
            {canWrite && current && (
              <button type="button" className={QUIET_LINK_CLASS} onClick={() => void cancelMandate(current)}>
                {t('mandate_cancel')}
              </button>
            )}
          </span>
          {latest.status_text && <span className="mt-1 block text-[12.5px] text-muted-foreground">{latest.status_text}</span>}
        </DefRow>
      )}

      {!current && state.enabled && canWrite && (
        state.settings_ready ? (
          <form onSubmit={(event) => void add(event)} className="flex flex-wrap items-center gap-2 py-2">
            <label htmlFor={`autogiro-payer-${customerId}`} className="w-full text-[13px] text-muted-foreground sm:w-auto">
              {t('customer_add_label')}
            </label>
            <Input
              id={`autogiro-payer-${customerId}`}
              inputMode="numeric"
              autoComplete="off"
              placeholder={t('customer_add_placeholder')}
              value={payerNumber}
              onChange={(event) => setPayerNumber(event.target.value)}
              className="w-44"
            />
            <Button type="submit" size="sm" variant="outline" loading={adding} disabled={!payerNumber.trim()}>
              {t('customer_add_action')}
            </Button>
          </form>
        ) : (
          <p className="py-2 text-[13px] text-muted-foreground">
            {t('customer_settings_missing')}{' '}
            <Link href="/invoices/autogiro" className={QUIET_LINK_CLASS}>
              {t('customer_settings_link')}
            </Link>
          </p>
        )
      )}

      <DestructiveConfirmDialog {...dialogProps} />
    </DetailSection>
  )
}

function MandateStatus({ mandate, t }: { mandate: AutogiroMandateRow; t: AutogiroT }) {
  const variant = MANDATE_STATUS_VARIANT[mandate.status]
  const label = t(`mandate_status_${mandate.status}`)
  return variant ? (
    <Badge variant={variant} className="font-normal">
      {label}
    </Badge>
  ) : (
    <span className="text-xs text-muted-foreground">{label}</span>
  )
}
