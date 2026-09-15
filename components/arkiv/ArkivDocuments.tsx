'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { ArkivDocumentRow } from '@/app/api/arkiv/documents/route'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'
import { formatCurrency, formatDate } from '@/lib/utils'

/** Type dropdown values: a group name the API understands, or one doc_type. */
const FILTERS: Array<{ value: string; labelKey: string }> = [
  { value: 'all', labelKey: 'filter_all_documents' },
  { value: 'agreement', labelKey: 'filter_agreements' },
  { value: 'authority', labelKey: 'filter_authority' },
  { value: 'receipt', labelKey: 'filter_receipts' },
  { value: 'supplier_invoice', labelKey: 'filter_supplier_invoices' },
  { value: 'bank_statement', labelKey: 'filter_bank_statements' },
  { value: 'other', labelKey: 'filter_other' },
]

/**
 * The Arkiv table with the toolbar of decision 8: type dropdown and search
 * on the left, the year picker far right, no attention line. `fixedType`
 * pins the list to one group (the Myndighet page).
 */
export function ArkivDocuments({ fixedType }: { fixedType?: string }) {
  const t = useTranslations('arkiv')
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
    const timer = setTimeout(() => {
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
    }, query ? 250 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [type, query, year])

  const years = useMemo(() => {
    const now = new Date().getFullYear()
    return Array.from({ length: 6 }, (_, i) => String(now - i))
  }, [])

  const typeLabel = (docType: string | null) => (docType && (DOC_TYPES as readonly string[]).includes(docType) ? t(`types.${docType}` as never) : t('types.other'))
  const linked = (row: ArkivDocumentRow) => {
    const parts: string[] = []
    if (row.linked.held) parts.push(t('linked_held'))
    if (row.linked.journal_entry_id) parts.push(t('linked_verifikat'))
    if (row.linked.agreement_id) parts.push(t('linked_agreement'))
    if (row.linked.facts > 0) parts.push(t('linked_facts', { count: row.linked.facts }))
    return parts.join(' · ')
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!fixedType && (
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="h-8 w-52 text-[13px]">
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
        <Input id="arkiv-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search_documents')} className="h-8 w-72 text-[13px]" />
        <Select value={year} onValueChange={setYear}>
          <SelectTrigger className="ml-auto h-8 w-32 text-[13px]">
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
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={`${TH_CLASS} pl-0`}>{t('col_date')}</th>
                <th className={TH_CLASS}>{t('col_document')}</th>
                <th className={TH_CLASS}>{t('col_type')}</th>
                <th className={TH_CLASS}>{t('col_counterparty')}</th>
                <th className={`${TH_CLASS} text-right`}>{t('col_amount')}</th>
                <th className={`${TH_CLASS} pr-0`}>{t('col_linked')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.document_id} className="hover:bg-secondary/35">
                  <td className={`${TD_CLASS} pl-0 tabular-nums text-muted-foreground`}>{formatDate(row.created_at)}</td>
                  <td className={`${TD_CLASS} max-w-[320px]`}>
                    <Link href={row.href} className={`${QUIET_LINK_CLASS} block truncate`} title={row.file_name}>
                      {row.file_name}
                    </Link>
                  </td>
                  <td className={`${TD_CLASS} text-muted-foreground`}>{typeLabel(row.doc_type)}</td>
                  <td className={`${TD_CLASS} max-w-[220px] truncate text-muted-foreground`}>{row.counterparty ?? ''}</td>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>{row.amount != null ? formatCurrency(row.amount, row.currency) : ''}</td>
                  <td className={`${TD_CLASS} pr-0 text-muted-foreground`}>{linked(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
