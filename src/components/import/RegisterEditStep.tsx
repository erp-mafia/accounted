'use client'

import { useMemo, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { ImportNotices } from '@/components/import/ImportNotices'
import { PossibleDuplicateChoice } from '@/components/import/PossibleDuplicateChoice'
import { makeNotice, type ImportNotice } from '@/lib/import/notices'
import { countMatchedRows } from '@/lib/import/register-import-flow'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Trash2, AlertTriangle, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RegisterImportConfig, ReviewRow } from '@/components/import/register-import-config'
import {
  RegisterColumnSummary,
  RegisterRowDetails,
  RowExpandButton,
  useExpandedRows,
} from '@/components/import/RegisterReviewDetails'

let idCounter = 0
const newId = () => `register_row_${++idCounter}_${Date.now()}`

type EditableRow = ReviewRow & { id: string }

interface RegisterEditStepProps {
  config: RegisterImportConfig
  rows: ReviewRow[]
  onExecute: (rows: ReviewRow[], updateDuplicates: boolean) => void
  onBack: () => void
  isLoading: boolean
  error: string | null
  /** What the parser noticed about the file (lib/import/notices.ts). */
  notices?: ImportNotice[]
  /** The file's header row, first rows and detected columns: the column summary. */
  headers: string[]
  previewRows: string[][]
  detectedColumns: Readonly<Record<string, number | null>>
}

/**
 * The review step of every register import: inline edits, the duplicate
 * choice, the column summary and the import button. The columns and the
 * register's own words come from its config (register-import-config.tsx).
 */
export default function RegisterEditStep({
  config,
  rows: initialRows,
  onExecute,
  onBack,
  isLoading,
  error,
  notices = [],
  headers,
  previewRows,
  detectedColumns,
}: RegisterEditStepProps) {
  const t = useTranslations('import.register_edit')
  const tMatch = useTranslations('import.register_match')
  const tCommon = useTranslations('common')
  const { entity, possibleDuplicate } = config
  const [rows, setRows] = useState<EditableRow[]>(() =>
    initialRows.map((r) => ({ ...r, id: newId() })),
  )
  const [updateDuplicates, setUpdateDuplicates] = useState(false)
  const [expanded, toggleExpanded] = useExpandedRows()

  const matchedCount = useMemo(() => countMatchedRows(rows), [rows])
  const possibleDuplicateCount = useMemo(
    () => (possibleDuplicate ? rows.filter((r) => r.possible_duplicate).length : 0),
    [rows, possibleDuplicate],
  )
  const newCount = rows.length - matchedCount
  const hasErrors = useMemo(() => rows.some((r) => !r.is_valid), [rows])
  const canContinue = rows.length > 0 && !hasErrors && !isLoading

  const updateRow = useCallback((id: string, updates: Partial<ReviewRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)))
  }, [])

  const deleteRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const handleExecute = () => {
    if (!canContinue) return
    onExecute(rows.map(({ id: _id, ...rest }) => rest), updateDuplicates)
  }

  // One notice block, so the page carries at most one ochre sentence
  // (ImportNotices, design convention 6).
  const allNotices: ImportNotice[] = [
    ...(hasErrors ? [makeNotice('rows_invalid', 'action')] : []),
    ...(possibleDuplicate && possibleDuplicateCount > 0
      ? [makeNotice(`possible_duplicate_${possibleDuplicate.party}s`, 'action', { count: possibleDuplicateCount })]
      : []),
    ...(config.rowNotices ? config.rowNotices(rows, notices) : notices),
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(`${entity}.title`)}</CardTitle>
        <CardDescription>
          {t(`${entity}.description`, { created: newCount, matched: matchedCount })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {matchedCount > 0 && (
          <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
            <RefreshCw className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="flex-1 space-y-2">
              <p className="text-sm">
                {tMatch.rich(`${entity}_matched`, {
                  count: matchedCount,
                  strong: (c) => <span className="font-medium">{c}</span>,
                })}
              </p>
              <div className="flex items-center gap-3">
                <Switch
                  id={`update-duplicates-${entity}`}
                  checked={updateDuplicates}
                  onCheckedChange={setUpdateDuplicates}
                />
                <Label htmlFor={`update-duplicates-${entity}`} className="text-sm cursor-pointer">
                  {updateDuplicates ? t(`${entity}.update_existing`) : t(`${entity}.skip_existing`)}
                </Label>
              </div>
              {updateDuplicates && (
                <p className="text-xs text-muted-foreground">{t(`${entity}.update_note`)}</p>
              )}
            </div>
          </div>
        )}

        <RegisterColumnSummary
          headers={headers}
          previewRows={previewRows}
          columns={detectedColumns}
          fields={config.reviewFields}
        />

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
              <tr className="border-b">
                {config.columns.map((col) => (
                  <th key={col.key} className={cn('px-3 py-2 text-left', col.headClassName)}>
                    {col.header}
                  </th>
                ))}
                <th className="px-3 py-2 text-left w-32">{t('col_status')}</th>
                <th className="px-3 py-2 w-24" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const existingId = possibleDuplicate?.existingId(row) ?? null
                return [
                  <tr
                    key={row.id}
                    className={cn('border-b last:border-0', !row.is_valid && 'bg-destructive/5')}
                  >
                    {config.columns.map((col) => (
                      <td key={col.key} className={cn('px-3 py-1.5', col.cellClassName)}>
                        {col.cell(row, (updates) => updateRow(row.id, updates))}
                      </td>
                    ))}
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        {!row.is_valid && (
                          <span
                            className="text-destructive shrink-0"
                            title={row.validation_errors.join(', ')}
                          >
                            <AlertTriangle className="h-3.5 w-3.5" />
                          </span>
                        )}
                        {possibleDuplicate && row.possible_duplicate && existingId ? (
                          <PossibleDuplicateChoice
                            party={possibleDuplicate.party}
                            existingName={row.possible_duplicate.existing_name}
                            confirmed={row.confirmed_duplicate_of === existingId}
                            onChange={(same) =>
                              updateRow(row.id, { confirmed_duplicate_of: same ? existingId : null })
                            }
                          />
                        ) : row.duplicate_match ? (
                          <span
                            className={cn(
                              'text-[11px] font-medium px-1.5 py-0.5 rounded-full',
                              updateDuplicates
                                ? 'bg-muted text-warning'
                                : 'bg-muted text-muted-foreground',
                            )}
                            title={t('match_title', {
                              name: row.duplicate_match.existing_name,
                              by: row.duplicate_match.matched_by,
                            })}
                          >
                            {updateDuplicates ? t('status_updated') : t('status_skipped')}
                          </span>
                        ) : (
                          <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-success/15 text-success">
                            {t('status_new')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center justify-end gap-1">
                        <RowExpandButton
                          expanded={expanded.has(row.id)}
                          onToggle={(trigger) => toggleExpanded(row.id, trigger)}
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('delete_row')}
                          onClick={() => deleteRow(row.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      </div>
                    </td>
                  </tr>,
                  <RegisterRowDetails
                    key={`${row.id}:details`}
                    row={row}
                    fields={config.reviewFields}
                    colSpan={expanded.get(row.id)}
                  />,
                ]
              })}
            </tbody>
          </table>
        </div>

        <ImportNotices notices={allNotices} />

        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={onBack} disabled={isLoading}>
            {tCommon('back')}
          </Button>
          <Button onClick={handleExecute} disabled={!canContinue} loading={isLoading}>
            {isLoading ? t('importing') : t('import_rows', { count: rows.length })}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
