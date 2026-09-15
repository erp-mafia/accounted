'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { QUIET_LINK_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { ArkivDocumentRow } from '@/app/api/arkiv/documents/route'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'
import { formatCurrency, formatDate } from '@/lib/utils'

/** Type dropdown values: a group name the API understands, or one doc_type. */
const FILTERS: Array<{ value: string; labelKey: string }> = [
  { value: 'all', labelKey: 'filter_all_documents' },
  { value: 'agreement', labelKey: 'filter_agreements' },
  { value: 'authority', labelKey: 'filter_authority' },
  { value: 'corporate', labelKey: 'filter_corporate' },
  { value: 'receipt', labelKey: 'filter_receipts' },
  { value: 'supplier_invoice', labelKey: 'filter_supplier_invoices' },
  { value: 'bank_statement', labelKey: 'filter_bank_statements' },
  { value: 'other', labelKey: 'filter_other' },
]

const PICKER_CLASS = 'h-8 w-auto gap-1.5 rounded-full px-3.5 text-[13px]'

/**
 * The Arkiv table (canvas artboard Arkiv): the type picker and the search
 * on the left, the year picker far right, no attention line. Columns:
 * date, document, type, counterparty, amount, and what it is tied to.
 * `fixedType` pins the list to one group (the Myndighet page).
 */
export function ArkivDocuments({ fixedType }: { fixedType?: string }) {
  const t = useTranslations('arkiv')
  const router = useRouter()
  const [type, setType] = useState(fixedType ?? 'all')
  const [query, setQuery] = useState('')
  const [year, setYear] = useState('all')
  const [rows, setRows] = useState<ArkivDocumentRow[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    if (type !== 'all') params.set('type', type)
    if (query.trim().length >= 2) params.set('q', query.trim())
    if (year !== 'all') params.set('year', year)
    const timer = setTimeout(
      () => {
        fetch(`/api/arkiv/documents?${params.toString()}`)
          .then(async (res) => {
            if (!res.ok) throw new Error(String(res.status))
            const { data } = (await res.json()) as { data: ArkivDocumentRow[] }
            if (!cancelled) {
              setRows(data)
              setFailed(false)
            }
          })
          .catch(() => {
            if (!cancelled) setFailed(true)
          })
      },
      query ? 250 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [type, query, year])

  const years = useMemo(() => {
    const now = new Date().getFullYear()
    return Array.from({ length: 6 }, (_, i) => String(now - i))
  }, [])

  const typeLabel = (docType: string | null) => (docType && (DOC_TYPES as readonly string[]).includes(docType) ? t(`types.${docType}` as never) : t('type_unknown'))
  const amountLabel = (row: ArkivDocumentRow) => {
    if (row.amount == null) return ''
    const period = row.period && row.period !== 'one_time' ? t(`period_short_${row.period}` as never) : ''
    return `${formatCurrency(row.amount, row.currency)}${period}`
  }
  const linked = (row: ArkivDocumentRow) => {
    if (row.linked.held) return <Badge variant="warning">{t('graph_waiting_held')}</Badge>
    if (row.linked.unclassified) return <Badge variant="warning">{t('linked_say_what')}</Badge>
    const parts: string[] = []
    if (row.linked.voucher) parts.push(t('record_verifikat', { voucher: row.linked.voucher }))
    else if (row.linked.journal_entry_id) parts.push(t('linked_verifikat'))
    if (row.linked.expected > 0) parts.push(t('linked_expected', { count: row.linked.expected }))
    if (row.linked.facts > 0) parts.push(t('linked_facts', { count: row.linked.facts }))
    return parts.join(' · ')
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!fixedType && (
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className={PICKER_CLASS} aria-label={t('col_type')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {t(f.labelKey as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <ToolbarSearch id="arkiv-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search_documents')} containerClassName="w-72" />
        <Select value={year} onValueChange={setYear}>
          <SelectTrigger className={`ml-auto ${PICKER_CLASS}`} aria-label={t('all_years')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('all_years')}</SelectItem>
            {years.map((y) => (
              <SelectItem key={y} value={y}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {failed && <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>}
      {!rows && !failed && (
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      )}
      {rows && rows.length === 0 && <EmptyState title={t('documents_empty_title')} description={t('documents_empty_body')} />}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full table-fixed border-collapse text-[13px]">
            <colgroup>
              <col className="w-[100px]" />
              <col className="w-[290px]" />
              <col className="w-[160px]" />
              <col className="w-[210px]" />
              <col className="w-[130px]" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th className={`${TH_CLASS} pl-1`}>{t('col_date')}</th>
                <th className={TH_CLASS}>{t('col_document')}</th>
                <th className={TH_CLASS}>{t('col_type')}</th>
                <th className={TH_CLASS}>{t('col_counterparty')}</th>
                <th className={`${TH_CLASS} text-right`}>{t('col_amount')}</th>
                <th className={TH_CLASS}>{t('col_linked')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.document_id} className="cursor-pointer hover:bg-secondary/35" onClick={() => router.push(row.href)}>
                  <td className={`${TD_CLASS} pl-1 tabular-nums text-muted-foreground`}>{row.document_date ?? formatDate(row.created_at)}</td>
                  <td className={`${TD_CLASS} truncate`}>
                    <Link href={row.href} className={`${QUIET_LINK_CLASS} text-[13px] text-foreground`} title={row.file_name}>
                      {row.title}
                    </Link>
                    {row.title !== row.file_name && !row.file_name.startsWith(row.title) ? <div className="truncate text-[11px] text-muted-foreground">{row.file_name}</div> : null}
                  </td>
                  <td className={`${TD_CLASS} truncate text-muted-foreground`}>{typeLabel(row.doc_type)}</td>
                  <td className={`${TD_CLASS} truncate text-muted-foreground`} title={row.counterparty ?? undefined}>
                    {row.counterparty ?? ''}
                  </td>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>{amountLabel(row)}</td>
                  <td className={`${TD_CLASS} truncate text-muted-foreground`}>{linked(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
