'use client'

import { useCallback, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { QUIET_LINK_CLASS, RowFoldout, VTD_CLASS, VTH_CLASS } from '@/components/ui/dry-table'
import { cn } from '@/lib/utils'
import { describeFileColumns, type FileColumnUse } from '@/lib/import/shared/file-columns'
import type { ReviewField } from '@/components/import/register-review-fields'

/** Ignored columns named in the summary sentence; the rest are counted. */
const IGNORED_NAMES_SHOWN = 5

interface RegisterColumnSummaryProps<K extends string> {
  headers: readonly unknown[]
  previewRows: readonly (readonly unknown[])[]
  /** The parse result's detected_columns (or the user's confirmed mapping). */
  columns: Readonly<Record<NoInfer<K>, number | null>>
  fields: Readonly<Record<K, { label: string }>>
}

/**
 * Read-only summary of how the register import reads the file: one sentence
 * naming the columns it leaves behind, and behind a toggle every file column
 * with the field it is imported as.
 */
export function RegisterColumnSummary<K extends string>({
  headers,
  previewRows,
  columns,
  fields,
}: RegisterColumnSummaryProps<K>) {
  const t = useTranslations('import_review')
  const [open, setOpen] = useState(false)

  const fileColumns = describeFileColumns(headers, previewRows, columns, Object.keys(fields) as K[])
  if (fileColumns.length === 0) return null

  const ignored = fileColumns.filter((c) => c.fields.length === 0)
  const columnName = (c: FileColumnUse<K>) => c.header || t('column_n', { n: c.index + 1 })
  const ignoredNames = ignored.slice(0, IGNORED_NAMES_SHOWN).map(columnName).join(', ')
  const ignoredMore = ignored.length - IGNORED_NAMES_SHOWN
  const names = (chunks: React.ReactNode) => <span className="text-foreground">{chunks}</span>

  return (
    <div className="space-y-2">
      <p className="text-[12.5px] leading-5 text-muted-foreground">
        {ignored.length === 0
          ? t('columns_all_imported', { total: fileColumns.length })
          : t('columns_imported', { used: fileColumns.length - ignored.length, total: fileColumns.length })}{' '}
        {ignored.length > 0 &&
          (ignoredMore > 0
            ? t.rich('columns_not_imported_more', { columns: ignoredNames, count: ignoredMore, names })
            : t.rich('columns_not_imported', { columns: ignoredNames, names }))}{' '}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={QUIET_LINK_CLASS}
        >
          {open ? t('hide_columns') : t('show_columns')}
        </button>
      </p>
      {open && (
        <table className="animate-fade-in border-collapse text-[12.5px]">
          <thead>
            <tr>
              <th className={VTH_CLASS}>{t('file_column')}</th>
              <th className={VTH_CLASS}>{t('imported_as')}</th>
            </tr>
          </thead>
          <tbody>
            {fileColumns.map((c) => (
              <tr key={c.index}>
                <td className={VTD_CLASS}>{columnName(c)}</td>
                <td className={cn(VTD_CLASS, c.fields.length === 0 && 'text-muted-foreground')}>
                  {c.fields.length > 0
                    ? c.fields.map((f) => fields[f].label).join(', ')
                    : t('not_imported')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/**
 * Which review rows are unfolded, each with the number of table columns its
 * details row spans. The span is read off the clicked row, so the details
 * always cover the whole table whatever columns the step renders.
 */
export function useExpandedRows() {
  const [spans, setSpans] = useState<ReadonlyMap<string, number>>(() => new Map())
  const toggle = useCallback((id: string, trigger: HTMLElement) => {
    const span = trigger.closest('tr')?.cells.length ?? 1
    setSpans((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, span)
      return next
    })
  }, [])
  return [spans, toggle] as const
}

export function RowExpandButton({
  expanded,
  onToggle,
}: {
  expanded: boolean
  onToggle: (trigger: HTMLElement) => void
}) {
  const t = useTranslations('import_review')
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-expanded={expanded}
      aria-label={expanded ? t('hide_fields') : t('show_fields')}
      onClick={(e) => onToggle(e.currentTarget)}
    >
      <ChevronRight
        className={cn(
          'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
          expanded && 'rotate-90',
        )}
      />
    </Button>
  )
}

/** Every field the import writes for one row, unfolded under it. */
export function RegisterRowDetails<R>({
  row,
  fields,
  colSpan,
}: {
  row: R
  fields: Readonly<Record<string, ReviewField<R>>>
  /** From useExpandedRows; undefined while the row is folded. */
  colSpan: number | undefined
}) {
  if (colSpan === undefined) return null
  return (
    <tr className="border-b last:border-0">
      <td colSpan={colSpan} className="p-0">
        <RowFoldout>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-3 pb-4 pt-2 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(fields).map(([key, field]) => {
              const value = field.value(row)
              return (
                <div key={key} className="min-w-0">
                  <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    {field.label}
                  </dt>
                  <dd
                    className={cn(
                      'break-words text-[13px] tabular-nums',
                      value === null && 'text-muted-foreground',
                    )}
                  >
                    {value ?? '-'}
                  </dd>
                </div>
              )
            })}
          </dl>
        </RowFoldout>
      </td>
    </tr>
  )
}
