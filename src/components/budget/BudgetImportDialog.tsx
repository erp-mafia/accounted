'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { FileDropzone } from '@/components/ui/file-dropzone'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { AttnLine } from '@/components/ui/attn-line'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { formatWholeKr } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { RESULT_CLASS_LABELS } from '@/lib/reports/result-class-labels'
import type { BudgetImportResult } from '@/lib/import/budget/import-budget'

type Sign = 'debit_positive' | 'revenue_positive'

/**
 * "Importera budget": a SIE file's #PBUDGET rows or an Excel/CSV sheet into
 * the open budget. The file is read on the server twice: first as a dry run,
 * the preview this dialog shows (what is read, what is skipped and why, the
 * budget per class and the result), then for real once confirmed, in one
 * save. The sign of a sheet and replace re-run the preview.
 */
export function BudgetImportDialog({
  open,
  onOpenChange,
  budgetId,
  budgetName,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  budgetId: string
  budgetName: string
  onDone: () => void
}) {
  const t = useTranslations('budget')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [sign, setSign] = useState<Sign | null>(null)
  const [replace, setReplace] = useState(false)
  const [preview, setPreview] = useState<BudgetImportResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (dryRun: boolean): Promise<{ ok: true; data: BudgetImportResult } | { ok: false; message: string }> => {
    const form = new FormData()
    form.append('file', file!)
    if (sign) form.append('sign', sign)
    form.append('replace', replace ? 'true' : 'false')
    try {
      // The preview is its own door: it only reads (lib/permissions/doors.ts).
      const res = await fetch(`/api/budgets/${budgetId}/import${dryRun ? '/preview' : ''}`, { method: 'POST', body: form })
      const body = await res.json().catch(() => null)
      if (!res.ok) return { ok: false, message: getErrorMessage(body, { statusCode: res.status, locale }) }
      return { ok: true, data: (body as { data: BudgetImportResult }).data }
    } catch (err) {
      return { ok: false, message: getErrorMessage(err, { locale }) }
    }
  }

  // The preview follows the file and the choices.
  useEffect(() => {
    if (!open || !file) return
    let live = true
    setLoading(true)
    setError(null)
    void send(true).then((res) => {
      if (!live) return
      setLoading(false)
      if (res.ok) setPreview(res.data)
      else {
        setPreview(null)
        setError(res.message)
      }
    })
    return () => {
      live = false
    }
    // send reads file, sign and replace, the deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file, sign, replace, budgetId])

  const submit = async () => {
    setBusy(true)
    const res = await send(false)
    setBusy(false)
    if (!res.ok) return setError(res.message)
    toast({ title: t('import_done', { cells: res.data.cells }) })
    onDone()
    onOpenChange(false)
  }

  const skipped = preview?.skipped
  const skippedLines = preview
    ? [
        skipped!.accounts_not_in_chart.length > 0 && t('import_skipped_accounts', { accounts: skipped!.accounts_not_in_chart.join(', ') }),
        skipped!.balance_accounts.length > 0 && t('import_skipped_balance', { accounts: skipped!.balance_accounts.join(', ') }),
        skipped!.unknown_objects.length > 0 &&
          t('import_skipped_objects', { objects: skipped!.unknown_objects.map((o) => `${o.dim_no} ${o.code}`).join(', ') }),
        skipped!.months_outside_year > 0 && t('import_skipped_months', { rows: skipped!.months_outside_year }),
        skipped!.unreadable_count > 0 &&
          t('import_skipped_unreadable', { rows: skipped!.unreadable_count, lines: skipped!.unreadable.map((u) => u.line).slice(0, 10).join(', ') }),
      ].filter((s): s is string => typeof s === 'string')
    : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('import_title')}</DialogTitle>
          <DialogDescription>{t('import_description', { budget: budgetName })}</DialogDescription>
        </DialogHeader>

        <FileDropzone onFile={setFile} label={t('import_pick')} invalid={error !== null && !preview} disabled={busy}>
          <p className="text-[13px]">{file ? file.name : t('import_pick')}</p>
          <p className="text-[12.5px] text-muted-foreground">{t('import_formats')}</p>
        </FileDropzone>

        {loading && <Skeleton className="h-24 w-full" />}

        {preview && !loading && (
          <div className="space-y-4 text-[13px]">
            <p>
              {t('import_summary', {
                cells: preview.cells,
                accounts: preview.accounts,
                format: t(`import_format_${preview.format}`),
              })}{' '}
              {preview.replace && preview.deleted > 0 ? t('import_replace_removes', { cells: preview.deleted }) : null}
            </p>

            {preview.format !== 'sie' && (
              <div className="space-y-2">
                <Label>{t('import_sign_label')}</Label>
                <SegmentedControl<Sign>
                  value={preview.sign}
                  onChange={setSign}
                  options={[
                    { value: 'revenue_positive', label: t('import_sign_revenue_positive') },
                    { value: 'debit_positive', label: t('import_sign_debit_positive') },
                  ]}
                />
              </div>
            )}
            {preview.sign_suspect && <AttnLine>{t('import_sign_suspect')}</AttnLine>}

            <table className="w-full border-collapse">
              <tbody>
                {preview.class_totals.map((c) => (
                  <tr key={c.account_class}>
                    <td className="py-1 text-muted-foreground">{RESULT_CLASS_LABELS[c.account_class]}</td>
                    <td className="py-1 text-right tabular-nums">{formatWholeKr(c.amount)}</td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <td className="py-1 border-t border-border">{t('result')}</td>
                  <td className="py-1 border-t border-border text-right tabular-nums">{formatWholeKr(preview.result)}</td>
                </tr>
              </tbody>
            </table>

            {skippedLines.length > 0 && (
              <ul className="space-y-1 text-[12.5px] text-muted-foreground">
                {skippedLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {file && (
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="import-replace" className="text-[13px] font-normal">
              {t('import_replace_label')}
            </Label>
            <Switch id="import-replace" checked={replace} onCheckedChange={setReplace} />
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={!preview || preview.cells === 0 || loading} loading={busy}>
            {t('import_submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
