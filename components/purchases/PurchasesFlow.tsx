'use client'

import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { AttnLine } from '@/components/ui/attn-line'
import { Skeleton } from '@/components/ui/skeleton'
import { AUTO_STAGES, SUPPLIER_INVOICE_STAGES, type SupplierInvoiceStage } from '@/lib/supplier-invoices/stages'

/**
 * Inköp as movement (UI v2): two lanes, one bar each, a count per stage and
 * a sentence per lane on what happens by itself and what needs a person.
 *
 * A receipt and a supplier invoice travel different roads to the same place,
 * the verifikat. The receipt is read, finds its bank transaction and is
 * booked with it. The invoice is registered, attested, paid, and its payment
 * meets the bank row later. Each cell opens the list that holds that stage;
 * the lists keep their own pickers. The bar is read-only on purpose: it is
 * the map, not another place to work.
 */

interface InboxItem {
  status: string
  matched_transaction_id: string | null
  created_journal_entry_id: string | null
  created_supplier_invoice_id: string | null
  matched_transaction_journal_entry_id?: string | null
}

type ReceiptStage = 'missing' | 'incoming' | 'read' | 'linked' | 'booked'
const RECEIPT_STAGES: readonly ReceiptStage[] = ['missing', 'incoming', 'read', 'linked', 'booked']
const RECEIPT_AUTO: ReadonlySet<ReceiptStage> = new Set(['incoming', 'read', 'linked'])
const INBOX_HREF = '/e/general/invoice-inbox'
const INVOICES_HREF = '/supplier-invoices'

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  return (await res.json()) as T
}

function receiptCounts(items: InboxItem[], missing: number): Record<ReceiptStage, number> {
  let booked = 0
  let linked = 0
  let read = 0
  for (const i of items) {
    const isBooked = !!(i.created_supplier_invoice_id || i.created_journal_entry_id || i.matched_transaction_journal_entry_id)
    if (isBooked) booked += 1
    if (isBooked || i.matched_transaction_id) linked += 1
    if (i.status !== 'processing') read += 1
  }
  // A funnel: every document that got further still counts at the earlier steps.
  return { missing, incoming: items.length, read, linked, booked }
}

function Lane({
  title,
  note,
  cells,
  auto,
  href,
}: {
  title: string
  note: string
  cells: Array<{ key: string; label: string; count: number; warn?: boolean }>
  auto: (key: string) => boolean
  href: string
}) {
  const t = useTranslations('purchases_flow')
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[13px] font-medium">{title}</h2>
        <Link href={href} className={cn(QUIET_LINK_CLASS, 'text-[12.5px]')}>
          {t('open_list')}
        </Link>
      </div>
      <div className="flex overflow-hidden rounded-lg border border-border">
        {cells.map((c) => (
          <Link
            key={c.key}
            href={href}
            className="flex h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 border-r border-border px-2 text-[12.5px] text-muted-foreground transition-colors duration-150 last:border-r-0 hover:bg-secondary/60 hover:text-foreground"
          >
            <span className="flex items-center gap-1.5">
              <span className="truncate">{c.label}</span>
              {auto(c.key) && <span className="text-[10.5px]">{t('auto')}</span>}
            </span>
            <span className={cn('font-medium tabular-nums', c.warn && c.count > 0 ? 'text-warning' : 'text-foreground')} data-ph-mask>
              {c.count || '–'}
            </span>
          </Link>
        ))}
      </div>
      <p className="max-w-[78ch] text-[12.5px] text-muted-foreground">{note}</p>
    </section>
  )
}

export function PurchasesFlow() {
  const t = useTranslations('purchases_flow')
  const tInv = useTranslations('supplier_invoices')

  const items = useSWR<{ data?: { items?: InboxItem[] } }>('/api/extensions/ext/invoice-inbox/items?limit=500', getJson)
  const purchases = useSWR<{ data?: { purchases?: unknown[] } }>('/api/extensions/ext/invoice-inbox/purchases', getJson)
  const lifecycle = useSWR<{ data?: { counts?: Partial<Record<SupplierInvoiceStage, number>> } }>('/api/supplier-invoices/lifecycle', getJson)

  const failed = items.error || purchases.error || lifecycle.error
  const loading = !items.data || !purchases.data || !lifecycle.data

  if (failed) {
    return (
      <AttnLine action={{ label: t('retry'), onClick: () => { void items.mutate(); void purchases.mutate(); void lifecycle.mutate() } }}>
        {t('load_failed')}
      </AttnLine>
    )
  }
  if (loading) {
    return (
      <div className="space-y-8" aria-busy>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }

  const rc = receiptCounts(items.data?.data?.items ?? [], purchases.data?.data?.purchases?.length ?? 0)
  const ic = lifecycle.data?.data?.counts ?? {}

  return (
    <div className="space-y-8">
      <Lane
        title={t('lane_receipts')}
        note={t('receipts_note')}
        href={INBOX_HREF}
        auto={(k) => RECEIPT_AUTO.has(k as ReceiptStage)}
        cells={RECEIPT_STAGES.map((s) => ({ key: s, label: t(`r_${s}`), count: rc[s], warn: s === 'missing' }))}
      />
      <Lane
        title={t('lane_invoices')}
        note={t('invoices_note')}
        href={INVOICES_HREF}
        auto={(k) => AUTO_STAGES.has(k as (typeof SUPPLIER_INVOICE_STAGES)[number])}
        cells={SUPPLIER_INVOICE_STAGES.map((s) => ({ key: s, label: tInv(`stage_${s}`), count: ic[s] ?? 0 }))}
      />
      <p className="text-[12.5px] text-muted-foreground">
        {t('legend')}
        {' · '}
        <Link href="/supplier-invoices/payment-files" className={QUIET_LINK_CLASS}>
          {t('link_payment_files')}
        </Link>
        {' · '}
        <Link href="/suppliers" className={QUIET_LINK_CLASS}>
          {t('link_suppliers')}
        </Link>
      </p>
    </div>
  )
}
