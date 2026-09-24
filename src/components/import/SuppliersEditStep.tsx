'use client'

import { useMemo, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { ImportNotices } from '@/components/import/ImportNotices'
import { makeNotice, type ImportNotice } from '@/lib/import/notices'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Trash2, AlertTriangle, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SupplierType } from '@/types'
import type { AnnotatedSupplierRow } from '@/lib/import/suppliers/types'

let idCounter = 0
const newId = () => `supp_row_${++idCounter}_${Date.now()}`

interface EditableSupplierRow extends AnnotatedSupplierRow {
  id: string
}

interface SuppliersEditStepProps {
  rows: AnnotatedSupplierRow[]
  onExecute: (rows: AnnotatedSupplierRow[], updateDuplicates: boolean) => void
  onBack: () => void
  isLoading: boolean
  error: string | null
  /** What the parser noticed about the file (lib/import/notices.ts). */
  notices?: ImportNotice[]
}

const SUPPLIER_TYPES: SupplierType[] = ['swedish_business', 'eu_business', 'non_eu_business']

export default function SuppliersEditStep({
  rows: initialRows,
  onExecute,
  onBack,
  isLoading,
  error,
  notices = [],
}: SuppliersEditStepProps) {
  const t = useTranslations('suppliers_edit_step')
  const typeLabel = (type: SupplierType): string => {
    switch (type) {
      case 'swedish_business':
        return t('type_swedish_business')
      case 'eu_business':
        return t('type_eu_business')
      case 'non_eu_business':
        return t('type_non_eu_business')
    }
  }
  const [rows, setRows] = useState<EditableSupplierRow[]>(() =>
    initialRows.map((r) => ({ ...r, id: newId() })),
  )
  const [updateDuplicates, setUpdateDuplicates] = useState(false)

  const liveDuplicateCount = useMemo(
    () => rows.filter((r) => r.duplicate_match !== null).length,
    [rows],
  )
  const newCount = rows.length - liveDuplicateCount

  const hasErrors = useMemo(() => rows.some((r) => !r.is_valid), [rows])

  const canContinue = rows.length > 0 && !hasErrors && !isLoading

  const updateRow = useCallback((id: string, updates: Partial<EditableSupplierRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)))
  }, [])

  const deleteRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const handleExecute = () => {
    if (!canContinue) return
    const stripped: AnnotatedSupplierRow[] = rows.map(({ id: _id, ...rest }) => rest)
    onExecute(stripped, updateDuplicates)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>
          {t('description', { count: newCount, duplicates: liveDuplicateCount })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {liveDuplicateCount > 0 && (
          <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
            <RefreshCw className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="flex-1 space-y-2">
              <p className="text-sm">
                {t.rich('duplicates_notice', {
                  count: liveDuplicateCount,
                  b: (chunks) => <span className="font-medium">{chunks}</span>,
                })}
              </p>
              <div className="flex items-center gap-3">
                <Switch
                  id="update-duplicates-supp"
                  checked={updateDuplicates}
                  onCheckedChange={setUpdateDuplicates}
                />
                <Label htmlFor="update-duplicates-supp" className="text-sm cursor-pointer">
                  {updateDuplicates
                    ? t('update_duplicates')
                    : t('skip_duplicates')}
                </Label>
              </div>
              {updateDuplicates && (
                <p className="text-xs text-muted-foreground">
                  {t('update_duplicates_hint')}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-2 text-left">{t('th_name')}</th>
                <th className="px-3 py-2 text-left w-44">{t('th_type')}</th>
                <th className="px-3 py-2 text-left w-36">{t('th_org_number')}</th>
                <th className="px-3 py-2 text-left w-32">{t('th_bank')}</th>
                <th className="px-3 py-2 text-left w-32">{t('th_status')}</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={cn(
                    'border-b last:border-0',
                    !row.is_valid && 'bg-destructive/5',
                  )}
                >
                  <td className="px-3 py-1.5">
                    <Input
                      value={row.name}
                      onChange={(e) => updateRow(row.id, { name: e.target.value })}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <Select
                      value={row.supplier_type}
                      onValueChange={(v) => updateRow(row.id, { supplier_type: v as SupplierType })}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPLIER_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {typeLabel(type)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground tabular-nums">
                    {row.org_number || '-'}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground tabular-nums truncate max-w-[10rem]">
                    {row.bankgiro || row.plusgiro || row.iban || '-'}
                  </td>
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
                      {row.duplicate_match ? (
                        <span
                          className={cn(
                            'text-[11px] font-medium px-1.5 py-0.5 rounded-full',
                            updateDuplicates
                              ? 'bg-muted text-warning'
                              : 'bg-muted text-muted-foreground',
                          )}
                          title={t('matches_existing', { name: row.duplicate_match.existing_name, matchedBy: row.duplicate_match.matched_by })}
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
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('delete_row')}
                      onClick={() => deleteRow(row.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ImportNotices
          notices={[
            ...(hasErrors ? [makeNotice('rows_invalid', 'action')] : []),
            ...notices,
          ]}
        />

        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={onBack} disabled={isLoading}>{t('back')}</Button>
          <Button onClick={handleExecute} disabled={!canContinue} loading={isLoading}>
            {isLoading
              ? t('importing')
              : t('import_rows', { count: rows.length })}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
