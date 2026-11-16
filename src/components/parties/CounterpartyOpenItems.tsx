'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { VTD_CLASS } from '@/components/ui/dry-table'
import { Skeleton } from '@/components/ui/skeleton'
import type { SetoffIneligibleReason } from '@/lib/invoices/counterparty-setoff/plan'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { formatCurrency, formatDate, formatRowAmount } from '@/lib/utils'
import { fetchCounterpartyOpenItems, type CounterpartyOpenItems as OpenItems } from './counterparty-client'
import { payableLabel, SetoffDialog } from './SetoffDialog'

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-medium text-muted-foreground">{children}</h2>
}

/**
 * "Öppna poster" in the party dossier (crm#1367): a counterparty that is both
 * customer and supplier, as one relation. What they owe us, what we owe them,
 * the net, and the Kvitta action while COUNTERPARTY_SETOFF_ENABLED is set.
 * Shown only when the party has both a customer and a supplier card, or
 * set-offs already.
 */
export function CounterpartyOpenItems({
  partyId,
  canWrite,
  reloadKey,
  onChanged,
}: {
  partyId: string
  canWrite: boolean
  reloadKey: number
  /** After a set-off: the dossier reloads what it shows from the ledger. */
  onChanged?: () => void
}) {
  const t = useTranslations('parties')
  const [loaded, setLoaded] = useState<{ key: string; items: OpenItems | null } | null>(null)
  const [localReload, setLocalReload] = useState(0)
  const [dialogOpen, setDialogOpen] = useState(false)
  const key = `${partyId}:${reloadKey}:${localReload}`

  useEffect(() => {
    let cancelled = false
    void fetchCounterpartyOpenItems(partyId).then((items) => {
      if (!cancelled) setLoaded({ key, items })
    })
    return () => {
      cancelled = true
    }
  }, [partyId, key])

  const items = loaded?.key === key ? loaded.items : (loaded?.items ?? null)
  if (!loaded) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }
  if (!items) return null
  const bothRoles = items.customers.length > 0 && items.suppliers.length > 0
  if (!bothRoles && items.setoffs.length === 0) return null

  const reasonText = (reason: SetoffIneligibleReason | null) => (reason ? t(`setoff_reason_${reason}` as never) : '')
  const canSetOff =
    items.setoff_enabled && canWrite && items.receivables.some((r) => r.setoff_eligible) && items.payables.some((p) => p.setoff_eligible)
  const arrivalWord = t('setoff_arrival_number')

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle>{t('section_open_items')}</SectionTitle>
        {canSetOff ? (
          <Button type="button" variant="outline" onClick={() => setDialogOpen(true)}>
            {t('setoff_action')}
          </Button>
        ) : null}
      </div>

      {items.totals.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('open_items_none')}</p>
      ) : (
        items.totals.map((total) => (
          <p key={total.currency} className="text-[13px] tabular-nums">
            {total.direction === 'we_pay'
              ? t('net_we_pay', { amount: formatCurrency(Math.abs(total.net), total.currency) })
              : total.direction === 'they_pay'
                ? t('net_they_pay', { name: items.party.name, amount: formatCurrency(total.net, total.currency) })
                : t('net_settled')}
            <span className="text-muted-foreground">
              {' · '}
              {t('open_items_totals', {
                receivable: formatCurrency(total.receivable, total.currency),
                payable: formatCurrency(total.payable, total.currency),
              })}
            </span>
          </p>
        ))
      )}

      {items.receivables.length > 0 ? (
        <table className="w-full text-[13px]">
          <caption className="pb-1 text-left text-xs text-muted-foreground">{t('open_receivables')}</caption>
          <tbody>
            {items.receivables.map((r) => (
              <tr key={r.invoice_id}>
                <td className={`${VTD_CLASS} w-24 whitespace-nowrap text-muted-foreground tabular-nums`}>{formatDate(r.invoice_date)}</td>
                <td className={`${VTD_CLASS} w-full max-w-0 truncate`}>
                  {r.number ?? ''}
                  {r.ineligible_reason ? <span className="text-muted-foreground"> · {reasonText(r.ineligible_reason)}</span> : null}
                </td>
                <td className={`${VTD_CLASS} text-right tabular-nums`}>{formatRowAmount(r.remaining_amount, r.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {items.payables.length > 0 ? (
        <table className="w-full text-[13px]">
          <caption className="pb-1 text-left text-xs text-muted-foreground">{t('open_payables')}</caption>
          <tbody>
            {items.payables.map((p) => (
              <tr key={p.supplier_invoice_id}>
                <td className={`${VTD_CLASS} w-24 whitespace-nowrap text-muted-foreground tabular-nums`}>{formatDate(p.invoice_date)}</td>
                <td className={`${VTD_CLASS} w-full max-w-0 truncate`}>
                  {payableLabel(p, arrivalWord)}
                  {p.ineligible_reason ? <span className="text-muted-foreground"> · {reasonText(p.ineligible_reason)}</span> : null}
                </td>
                <td className={`${VTD_CLASS} text-right tabular-nums`}>{formatRowAmount(p.remaining_amount, p.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {items.setoffs.length > 0 ? (
        <table className="w-full text-[13px]">
          <caption className="pb-1 text-left text-xs text-muted-foreground">{t('setoff_history')}</caption>
          <tbody>
            {items.setoffs.map((s) => (
              <tr key={s.setoff_id}>
                <td className={`${VTD_CLASS} w-24 whitespace-nowrap text-muted-foreground tabular-nums`}>{formatDate(s.setoff_date)}</td>
                <td className={`${VTD_CLASS} w-full max-w-0 truncate`}>
                  {t('setoff_history_row')}
                  {s.status === 'reversed' ? <span className="text-muted-foreground"> · {t('setoff_reversed')}</span> : null}
                </td>
                <td className={`${VTD_CLASS} text-right tabular-nums`}>{formatRowAmount(s.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <p className="text-xs text-muted-foreground">{t('open_items_credit_notes')}</p>

      {canSetOff ? (
        <SetoffDialog
          partyId={items.party.party_id}
          counterpartyName={items.party.name}
          receivables={items.receivables}
          payables={items.payables}
          today={todayIsoStockholm()}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onDone={() => {
            setLocalReload((n) => n + 1)
            onChanged?.()
          }}
        />
      ) : null}
    </section>
  )
}
