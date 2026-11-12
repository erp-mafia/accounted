'use client'

import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { useTranslations } from 'next-intl'
import { cn, formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { QUIET_LINK_CLASS, VTH_CLASS, VTD_CLASS } from '@/components/ui/dry-table'
import { isUuid } from '@/lib/invariants/uuid'

/**
 * link_documents_to_vouchers: up to 300 document-to-verifikat pairings staged
 * as one approval. The pairings are what the approver approves, so they are
 * the card: file, verifikat, date and outcome per row, with the counts above.
 * The generic preview rendered the results array as "N rader", which left
 * nothing to check before approving (agent feedback seq 921931).
 *
 * A matched_copy row archives a byte-identical copy of a document another
 * verifikat holds (crm#1207): it is linked like a matched row, and the count
 * of copies sits with the totals so the approver sees new files are made.
 */

interface LinkResultRow {
  document_id?: string
  document_file_name?: string
  voucher_series?: string
  voucher_number?: number
  voucher_label?: string
  voucher_date?: string
  status?: string
}

function isResultRows(value: unknown): value is LinkResultRow[] {
  return Array.isArray(value) && value.every((r) => typeof r === 'object' && r !== null)
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function LinkDocumentsPreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('pending')
  const rows = isResultRows(data.results) ? data.results : []
  const total = count(data.total) || rows.length
  const matched = count(data.matched_count)
  const locked = count(data.period_locked_count)
  const copies = count(data.copy_count)
  const unmatched = Math.max(0, count(data.missed_count) - locked)

  const statusLabel = (status: string | undefined) =>
    status && t.has(`link_preview_status_${status}`) ? t(`link_preview_status_${status}`) : (status ?? '-')
  const voucher = (row: LinkResultRow) =>
    row.voucher_label ??
    (row.voucher_series && row.voucher_number ? formatVoucher(row) : '-')

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">{t('link_preview_linked')}</span>
        <span className="tabular-nums">{t('link_preview_of_total', { count: matched, total })}</span>
        {copies > 0 && (
          <>
            <span className="text-muted-foreground">{t('link_preview_copies')}</span>
            <span className="tabular-nums">{copies}</span>
          </>
        )}
        {unmatched > 0 && (
          <>
            <span className="text-muted-foreground">{t('link_preview_unmatched')}</span>
            <span className="tabular-nums">{unmatched}</span>
          </>
        )}
        {locked > 0 && (
          <>
            <span className="text-muted-foreground">{t('link_preview_locked')}</span>
            <span className="tabular-nums">{locked}</span>
          </>
        )}
      </div>
      {rows.length > 0 && (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full border-collapse text-[12.5px]" aria-label={t('link_preview_table_label')}>
            <thead>
              <tr>
                <th className={VTH_CLASS}>{t('link_preview_file')}</th>
                <th className={VTH_CLASS}>{t('link_preview_voucher')}</th>
                <th className={VTH_CLASS}>{t('link_preview_date')}</th>
                <th className={VTH_CLASS}>{t('link_preview_outcome')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={`${row.document_id ?? ''}-${i}`}>
                  <td className={cn(VTD_CLASS, 'min-w-0 break-all')} data-ph-mask="">
                    {/* Each pairing's file opens in a new tab: the row is what is approved. */}
                    {isUuid(row.document_id) ? (
                      <a
                        href={`/api/documents/${row.document_id}/inline`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={QUIET_LINK_CLASS}
                      >
                        {row.document_file_name ?? t('link_preview_file')}
                      </a>
                    ) : (
                      (row.document_file_name ?? '-')
                    )}
                  </td>
                  <td className={cn(VTD_CLASS, 'whitespace-nowrap font-mono tabular-nums')}>{voucher(row)}</td>
                  <td className={cn(VTD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                    {row.voucher_date ? formatDate(row.voucher_date) : ''}
                  </td>
                  <td className={cn(VTD_CLASS, 'whitespace-nowrap')}>
                    {/* Chips mark exceptions: a row that will be linked is muted text. */}
                    {row.status === 'matched' || row.status === 'matched_copy' ? (
                      <span className="text-muted-foreground">{statusLabel(row.status)}</span>
                    ) : (
                      <Badge variant="warning">{statusLabel(row.status)}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
