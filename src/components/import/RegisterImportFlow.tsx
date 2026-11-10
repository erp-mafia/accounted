'use client'

import { useCallback, useState } from 'react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { SpinnerIcon } from '@/components/icons'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { ARTICLE_BROWSER_MAX_FILE_BYTES } from '@/lib/import/articles/browser-parse'
import { legacyNotices, type ImportNotice } from '@/lib/import/notices'
import type { RegisterImportEntity } from '@/lib/import/register-import-link'
import {
  columnsToMapping,
  executeBatches,
  mappingToOverrides,
  mergeExecuteResults,
  needsColumnMapping,
  registerImportEndpoint,
  registerSteps,
  rowsForExecute,
  stoppedImportParams,
  type RegisterStep,
} from '@/lib/import/register-import-flow'
import RegisterColumnMappingStep from '@/components/import/RegisterColumnMappingStep'
import { ImportWizardRail } from '@/components/import/ImportWizardRail'
import type { RegisterResult } from '@/components/import/RegisterResultStep'
import { useRegisterImportConfig, type ReviewRow } from '@/components/import/register-import-config'

function StepLoading() {
  return (
    <div className="flex min-h-48 items-center justify-center" role="status">
      <SpinnerIcon className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  )
}

const RegisterUploadStep = dynamic(() => import('@/components/import/RegisterUploadStep'), { loading: StepLoading })
const RegisterEditStep = dynamic(() => import('@/components/import/RegisterEditStep'), { loading: StepLoading })
const RegisterResultStep = dynamic(() => import('@/components/import/RegisterResultStep'), { loading: StepLoading })

/** What the parse route answers for every register (lib/import/<register>/types.ts). */
interface RegisterParseResult {
  detected_columns: { confidence: number } & Record<string, number | null>
  headers: string[]
  preview_rows: string[][]
  rows: ReviewRow[]
  duplicate_count: number
  warnings: string[]
  notices?: ImportNotice[]
}

/**
 * The CSV/Excel import wizard for one register (Kunder, Leverantörer,
 * Artiklar): upload, column mapping when detection is unsure, review, result.
 * The steps are the same for every register; what differs is its config.
 */
export default function RegisterImportFlow({
  entity,
  onBack,
  entityPicker,
}: {
  entity: RegisterImportEntity
  /** Back to the import choices: the rail's first crumb. */
  onBack?: () => void
  /** The register picker, rendered under the rail. */
  entityPicker?: React.ReactNode
}) {
  const { toast } = useToast()
  const t = useTranslations('import.register_flow')
  const config = useRegisterImportConfig(entity)
  const mappingKeys = config.columnSpecs.map((s) => s.key)

  const [step, setStep] = useState<RegisterStep>('upload')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [parseResult, setParseResult] = useState<RegisterParseResult | null>(null)
  const [executeResult, setExecuteResult] = useState<RegisterResult | null>(null)
  /** Rows written so far, while a file too large for one request goes in batches. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const needsMapping = parseResult !== null && needsColumnMapping(parseResult.detected_columns)
  const steps = registerSteps(needsMapping)

  const parse = useCallback(
    async (selectedFile: File, overrides?: Record<string, number | null>): Promise<{ ok: true; result: RegisterParseResult } | { ok: false; message: string }> => {
      if (config.parseInBrowser) {
        const outcome = await config.parseInBrowser(selectedFile, overrides)
        if (outcome.ok) return { ok: true, result: outcome.result as unknown as RegisterParseResult }
        if (outcome.reason === 'too_large') {
          return { ok: false, message: t('file_too_large', { max: `${ARTICLE_BROWSER_MAX_FILE_BYTES / 1024 / 1024} MB` }) }
        }
        return { ok: false, message: outcome.message || (overrides ? t('remap_failed') : t('parse_failed')) }
      }
      const formData = new FormData()
      formData.append('file', selectedFile)
      if (overrides) formData.append('column_overrides', JSON.stringify(overrides))
      const res = await fetch(registerImportEndpoint(entity, 'parse'), { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) {
        return {
          ok: false,
          message:
            data.error?.message_sv ||
            getErrorMessage(data.error) ||
            (overrides ? t('remap_failed') : t('parse_failed')),
        }
      }
      return { ok: true, result: data.data as RegisterParseResult }
    },
    [config, entity, t],
  )

  const handleFileSelect = useCallback(async (selectedFile: File) => {
    setError(null)
    setIsLoading(true)
    setFile(selectedFile)

    try {
      const parsed = await parse(selectedFile)
      if (!parsed.ok) {
        setError(parsed.message)
        return
      }
      const result = parsed.result
      setParseResult(result)

      if (result.rows.length === 0) {
        setError(t(`${entity}.no_rows`))
        return
      }

      toast({
        title: t('parsed_title'),
        description: t(`${entity}.parsed`, { count: result.rows.length, matched: result.duplicate_count }),
      })

      setStep(needsColumnMapping(result.detected_columns) ? 'column_mapping' : 'edit')
    } catch (err) {
      setError(err instanceof Error ? getErrorMessage(err) : t('parse_failed'))
    } finally {
      setIsLoading(false)
    }
  }, [entity, parse, t, toast])

  const handleColumnMappingConfirm = useCallback(async (mapping: Record<string, number | null>) => {
    if (!file) return
    setIsLoading(true)
    setError(null)

    try {
      const parsed = await parse(file, mappingToOverrides(mapping))
      if (!parsed.ok) {
        setError(parsed.message)
        return
      }
      setParseResult(parsed.result)
      setStep('edit')
    } catch (err) {
      setError(err instanceof Error ? getErrorMessage(err) : t('parse_failed'))
    } finally {
      setIsLoading(false)
    }
  }, [file, parse, t])

  /**
   * One batch to the execute route. A dropped connection or a server error is
   * tried once more: a batch is safe to send twice, since its rows then
   * match the articles (customers, suppliers) the first attempt created and
   * are skipped or updated with the same values, never created twice.
   */
  const postBatch = useCallback(
    async (batch: Record<string, unknown>[], updateDuplicates: boolean): Promise<{ ok: true; result: RegisterResult } | { ok: false; message: string }> => {
      for (let attempt = 0; ; attempt++) {
        let res: Response
        try {
          res = await fetch(registerImportEndpoint(entity, 'execute'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: batch, update_duplicates: updateDuplicates }),
          })
        } catch (err) {
          if (attempt === 0) continue
          return { ok: false, message: err instanceof Error ? getErrorMessage(err) : t('execute_failed') }
        }
        // A platform error (413, 504) answers in plain text, not JSON.
        const data = await res.json().catch(() => null)
        if (res.ok && data?.data) return { ok: true, result: data.data as RegisterResult }
        if (res.status >= 500 && attempt === 0) continue
        return {
          ok: false,
          message: data?.error?.message_sv || (data?.error ? getErrorMessage(data.error) : '') || t('execute_failed'),
        }
      }
    },
    [entity, t],
  )

  const handleExecute = useCallback(async (rows: ReviewRow[], updateDuplicates: boolean) => {
    setIsLoading(true)
    setError(null)

    try {
      const payload = rowsForExecute(rows, config.executeReviewOnly)
      const batches = executeBatches(payload)
      const results: RegisterResult[] = []
      let done = 0
      if (batches.length > 1) setProgress({ done, total: payload.length })
      for (const batch of batches) {
        const outcome = await postBatch(batch, updateDuplicates)
        if (!outcome.ok) {
          // Earlier batches are in: say the line it stopped at, what the
          // earlier batches could not import, and that a new run picks up
          // from there without creating anything twice.
          setError(
            done > 0
              ? `${outcome.message} ${t('execute_partial', stoppedImportParams(results, batch, done, payload.length))}`
              : outcome.message,
          )
          return
        }
        results.push(outcome.result)
        done += batch.length
        if (batches.length > 1) setProgress({ done, total: payload.length })
      }

      const r = mergeExecuteResults(results)
      setExecuteResult(r)
      setStep('result')
      toast({
        title: r.success ? t(`${entity}.imported_title`) : t('imported_with_errors_title'),
        description: t('imported_description', {
          created: r.created,
          updated: r.updated,
          skipped: r.skipped,
          failed: r.failed,
        }),
        variant: r.success ? 'default' : 'destructive',
      })
    } catch (err) {
      setError(err instanceof Error ? getErrorMessage(err) : t('execute_failed'))
    } finally {
      setIsLoading(false)
      setProgress(null)
    }
  }, [config.executeReviewOnly, entity, postBatch, t, toast])

  const handleNewImport = () => {
    setStep('upload')
    setFile(null)
    setParseResult(null)
    setExecuteResult(null)
    setError(null)
  }

  const stepLabel = (s: RegisterStep) => t(`step_${s}`)

  return (
    <div className="space-y-6">
      <ImportWizardRail steps={steps} current={step} label={stepLabel} onBack={onBack} />
      {entityPicker}

      {step === 'upload' && (
        <RegisterUploadStep
          entity={entity}
          onFileSelect={handleFileSelect}
          isLoading={isLoading}
          error={error}
        />
      )}

      {step === 'column_mapping' && parseResult && (
        <RegisterColumnMappingStep<string>
          headers={parseResult.headers}
          previewRows={parseResult.preview_rows}
          specs={config.columnSpecs}
          initial={columnsToMapping(parseResult.detected_columns, mappingKeys)}
          onConfirm={handleColumnMappingConfirm}
          onBack={() => setStep('upload')}
          notices={parseResult.notices ?? legacyNotices(parseResult.warnings)}
        />
      )}

      {step === 'edit' && parseResult && (
        <RegisterEditStep
          config={config}
          rows={parseResult.rows}
          headers={parseResult.headers}
          previewRows={parseResult.preview_rows}
          detectedColumns={parseResult.detected_columns}
          notices={parseResult.notices ?? legacyNotices(parseResult.warnings)}
          onExecute={handleExecute}
          onBack={() => setStep(needsMapping ? 'column_mapping' : 'upload')}
          isLoading={isLoading}
          progress={progress}
          error={error}
        />
      )}

      {step === 'result' && executeResult && (
        <RegisterResultStep
          entity={entity}
          result={executeResult}
          onNewImport={handleNewImport}
        />
      )}
    </div>
  )
}
