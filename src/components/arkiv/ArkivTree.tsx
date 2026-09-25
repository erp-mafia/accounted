'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Banknote, ChevronRight, File, FileOutput, FileQuestion, FileSignature, FileText, ScrollText, ShoppingBag, Stamp, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import type { ArkivDocumentRow } from '@/app/api/arkiv/documents/route'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'
import { groupByFolder, openByDefault, type FolderKey } from '@/lib/arkiv/folders'
import { formatCurrency, formatDate } from '@/lib/utils'

/**
 * The archive as folders (2026-09-24, after the Oasis Wiki): one shelf per
 * kind of document, the small folders open on arrival and the untyped one
 * always, each row the same one line as the table had: date, title with
 * its file, counterparty, amount, what it is tied to. A folder shows its
 * first rows and offers the rest; the year picker sits far right
 * (convention 8).
 */
const PICKER_CLASS = 'h-8 w-auto gap-1.5 rounded-full px-3.5 text-[13px]'
const LIMIT = 500
const SHOW_FIRST = 8

// Myndigheter is a stamp, not a bank; a receipt is a purchase already paid, so a bag, not a till slip (founder, 2026-09-24).
const ICONS: Record<FolderKey, LucideIcon> = {
  agreements: FileSignature,
  authority: Stamp,
  corporate: ScrollText,
  receipts: ShoppingBag,
  supplier_invoices: FileText,
  customer_invoices: FileOutput,
  bank_statements: Banknote,
  other: File,
  untyped: FileQuestion,
}

export function ArkivTree({ refreshKey = 0 }: { refreshKey?: number }) {
  const t = useTranslations('arkiv')
  const router = useRouter()
  const [year, setYear] = useState('all')
  const [rows, setRows] = useState<ArkivDocumentRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<Partial<Record<FolderKey, boolean>>>({})
  const [expanded, setExpanded] = useState<Partial<Record<FolderKey, boolean>>>({})

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ limit: String(LIMIT) })
    if (year !== 'all') params.set('year', year)
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
    return () => {
      cancelled = true
    }
  }, [year, refreshKey])

  const years = useMemo(() => {
    const now = new Date().getFullYear()
    return Array.from({ length: 6 }, (_, i) => String(now - i))
  }, [])
  const folders = useMemo(() => groupByFolder(rows ?? []), [rows])
  const untyped = folders.find((f) => f.key === 'untyped')?.rows.length ?? 0

  const typeLabel = (docType: string) => ((DOC_TYPES as readonly string[]).includes(docType) ? t(`types.${docType}` as never) : docType)
  const fileMeta = (row: ArkivDocumentRow) => [row.file_name, row.page_count && row.page_count > 1 ? t('tree_pages', { count: row.page_count }) : null].filter(Boolean).join(' · ')
  const amountLabel = (row: ArkivDocumentRow) => {
    if (row.amount == null) return ''
    const period = row.period && row.period !== 'one_time' ? t(`period_short_${row.period}` as never) : ''
    return `${formatCurrency(row.amount, row.currency, { minimumFractionDigits: 2 })}${period}`
  }
  const linked = (row: ArkivDocumentRow) => {
    if (row.linked.held) return <Badge variant="warning">{t('graph_waiting_held')}</Badge>
    if (row.linked.unclassified) return <Badge variant="warning">{t('linked_say_what')}</Badge>
    if (row.linked.reading && !row.linked.voucher && !row.linked.journal_entry_id) return <span className="text-muted-foreground">{t('linked_reading')}</span>
    return row.linked.voucher ? t('record_verifikat', { voucher: row.linked.voucher }) : row.linked.journal_entry_id ? t('linked_verifikat') : ''
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {rows && rows.length > 0 ? (
          <span className="text-[12.5px] text-muted-foreground">
            {t('tree_count', { count: rows.length })}
            {untyped > 0 ? ` · ${t('tree_untyped_count', { count: untyped })}` : ''}
          </span>
        ) : null}
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
        <div className="stagger-enter">
          {folders.map((folder) => {
            const Icon = ICONS[folder.key]
            const isOpen = open[folder.key] ?? openByDefault(folder.key, folder.rows.length)
            const showAll = expanded[folder.key] ?? false
            const shown = showAll ? folder.rows : folder.rows.slice(0, SHOW_FIRST)
            const mix =
              folder.key === 'untyped'
                ? t('folder_untyped_hint')
                : folder.types.length > 1
                  ? folder.types
                      .slice(0, 3)
                      .map((x) => `${typeLabel(x.doc_type)} ${x.count}`)
                      .join(', ')
                  : null
            return (
              <details
                key={folder.key}
                open={isOpen}
                onToggle={(e) => {
                  const next = (e.currentTarget as HTMLDetailsElement).open
                  setOpen((m) => (m[folder.key] === next ? m : { ...m, [folder.key]: next }))
                }}
                className="border-b border-border"
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-[13px] [&::-webkit-details-marker]:hidden">
                  <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="font-medium">{t(`folder_${folder.key}` as never)}</span>
                  {mix ? <span className="truncate text-[12.5px] text-muted-foreground">{mix}</span> : null}
                  <span className="ml-auto text-[12.5px] tabular-nums text-muted-foreground">{folder.rows.length}</span>
                </summary>
                <div className="overflow-x-auto pb-2 pl-10">
                  <table className="w-full table-fixed border-collapse text-[13px]">
                    <colgroup>
                      <col className="w-[100px]" />
                      <col />
                      <col className="w-[200px]" />
                      <col className="w-[130px]" />
                      <col className="w-[160px]" />
                    </colgroup>
                    <tbody>
                      {shown.map((row) => (
                        <tr key={row.document_id} className="cursor-pointer hover:bg-secondary/35" onClick={() => router.push(row.href)}>
                          <td className={`${TD_CLASS} pl-1 tabular-nums text-muted-foreground`}>{row.document_date ?? formatDate(row.created_at)}</td>
                          <td className={`${TD_CLASS} truncate`} title={fileMeta(row)}>
                            <Link href={row.href} className={`${QUIET_LINK_CLASS} text-[13px] text-foreground`}>
                              {row.title}
                            </Link>
                            <span className="ml-2 text-[11px] text-muted-foreground">{fileMeta(row)}</span>
                          </td>
                          <td className={`${TD_CLASS} truncate text-muted-foreground`} title={row.counterparty ?? undefined}>
                            {row.counterparty ?? ''}
                          </td>
                          <td className={`${TD_CLASS} text-right tabular-nums`}>{amountLabel(row)}</td>
                          <td className={`${TD_CLASS} truncate text-muted-foreground`}>{linked(row)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {folder.rows.length > SHOW_FIRST ? (
                    <button
                      type="button"
                      className="mt-1 text-[12.5px] text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
                      onClick={() => setExpanded((m) => ({ ...m, [folder.key]: !showAll }))}
                    >
                      {showAll ? t('tree_show_fewer') : t('tree_show_more', { count: folder.rows.length - SHOW_FIRST })}
                    </button>
                  ) : null}
                </div>
              </details>
            )
          })}
        </div>
      )}
      {rows && rows.length >= LIMIT ? <p className="text-[12.5px] text-muted-foreground">{t('tree_capped', { count: LIMIT })}</p> : null}
    </div>
  )
}
