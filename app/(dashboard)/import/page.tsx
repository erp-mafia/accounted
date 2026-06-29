'use client'

import { useState, useCallback, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { ArrowLeftRight, ArrowRightLeft, FileText, ArrowLeft, Landmark, Loader2, Info, ChevronRight, FileSpreadsheet, Download, AlertTriangle } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn, formatDate } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { BankSelector, type Bank } from '@/extensions/general/enable-banking/components/BankSelector'
import { BankConnectionStatus } from '@/extensions/general/enable-banking/components/BankConnectionStatus'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import type { BankConnection } from '@/types'

// Bank file import components
import BankFileUploadStep from '@/components/import/BankFileUploadStep'
import BankFilePreviewStep from '@/components/import/BankFilePreviewStep'
import BankFileColumnMappingStep from '@/components/import/BankFileColumnMappingStep'
import BankFileConfirmStep from '@/components/import/BankFileConfirmStep'
import BankFileResultStep from '@/components/import/BankFileResultStep'

// Opening balance import components
import OpeningBalanceUploadStep from '@/components/import/OpeningBalanceUploadStep'
import OpeningBalanceColumnMappingStep from '@/components/import/OpeningBalanceColumnMappingStep'
import OpeningBalanceEditStep from '@/components/import/OpeningBalanceEditStep'
import OpeningBalancePeriodStep from '@/components/import/OpeningBalancePeriodStep'
import OpeningBalanceResultStep from '@/components/import/OpeningBalanceResultStep'
import type { OpeningBalanceParseResult, OpeningBalanceExecuteResult, DetectedColumns } from '@/lib/import/opening-balance/types'

// Register import (customers/suppliers) components
import RegisterUploadStep from '@/components/import/RegisterUploadStep'
import RegisterColumnMappingStep, { type RegisterColumnSpec } from '@/components/import/RegisterColumnMappingStep'
import CustomersEditStep from '@/components/import/CustomersEditStep'
import SuppliersEditStep from '@/components/import/SuppliersEditStep'
import ArticlesEditStep from '@/components/import/ArticlesEditStep'
import RegisterResultStep, { type RegisterResult } from '@/components/import/RegisterResultStep'
import type {
  CustomerImportParseResult,
  AnnotatedCustomerRow,
  DetectedCustomerColumns,
} from '@/lib/import/customers/types'
import type {
  SupplierImportParseResult,
  AnnotatedSupplierRow,
  DetectedSupplierColumns,
} from '@/lib/import/suppliers/types'
import type {
  ArticleImportParseResult,
  AnnotatedArticleRow,
  DetectedArticleColumns,
} from '@/lib/import/articles/types'

// SIE import components
import SIEUploadStep from '@/components/import/SIEUploadStep'
import SIEPreviewStep from '@/components/import/SIEPreviewStep'
import AccountMappingStep from '@/components/import/AccountMappingStep'
import ImportReviewStep, { type ImportExecuteOptions } from '@/components/import/ImportReviewStep'
import ImportResultStep from '@/components/import/ImportResultStep'
import { applyMappingOverride } from '@/lib/import/account-mapper'
import type { BankFileParseResult, BankFileFormatId, GenericCSVColumnMapping } from '@/lib/import/bank-file/types'
import type { IngestResult } from '@/lib/transactions/ingest'
import type {
  ImportWizardStep,
  ParsedSIEFile,
  AccountMapping,
  ImportPreview,
  ImportResult,
  ParseIssue,
} from '@/lib/import/types'
import type { BASAccount } from '@/types'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import dynamic from 'next/dynamic'
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import CloudBackupCard from '@/extensions/general/cloud-backup/components/CloudBackupCard'
import BankSyncStatusChip from '@/components/transactions/BankSyncStatusChip'

const MigrationWizard = dynamic(
  () => import('@/components/extensions/general/ArcimMigrationWorkspace'),
  { ssr: false, loading: () => <div className="flex items-center gap-3 text-muted-foreground p-6"><Loader2 className="h-5 w-5 animate-spin" />Laddar migreringsverktyg...</div> }
)

// ============================================================
// Bank File Import Wizard Steps
// ============================================================

type BankFileStep = 'upload' | 'preview' | 'column_mapping' | 'confirm' | 'result'

const BANK_STEPS: BankFileStep[] = ['upload', 'preview', 'confirm', 'result']
const BANK_STEPS_WITH_MAPPING: BankFileStep[] = ['upload', 'column_mapping', 'confirm', 'result']

const BANK_STEP_LABELS: Record<BankFileStep, string> = {
  upload: 'Ladda upp',
  preview: 'Förhandsgranskning',
  column_mapping: 'Kolumnmappning',
  confirm: 'Bekräfta',
  result: 'Resultat',
}

function BankFileImportWizard() {
  const { toast } = useToast()
  const tTx = useTranslations('transactions')
  const { company } = useCompany()

  const [bankStep, setBankStep] = useState<BankFileStep>('upload')
  const [bankIsLoading, setBankIsLoading] = useState(false)
  const [bankError, setBankError] = useState<string | null>(null)
  const [bankErrorTitle, setBankErrorTitle] = useState<string | null>(null)

  // Parse results
  const [parseResult, setParseResult] = useState<BankFileParseResult | null>(null)
  const [detectedFormat, setDetectedFormat] = useState<string | null>(null)
  const [detectedFormatName, setDetectedFormatName] = useState<string | null>(null)
  const [fileHash, setFileHash] = useState<string>('')
  const [filename, setFilename] = useState<string>('')
  const [rawFileContent, setRawFileContent] = useState<string>('')

  // Import result
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null)

  // Active PSD2 connections — drives an overlap warning so users don't
  // accidentally upload a CSV covering periods we already sync nightly.
  const [activePsd2Banks, setActivePsd2Banks] = useState<string[]>([])
  useEffect(() => {
    if (!company?.id) return
    let cancelled = false
    const supabase = createClient()
    supabase
      .from('bank_connections')
      .select('bank_name')
      .eq('company_id', company.id)
      .eq('status', 'active')
      .then(({ data }) => {
        if (cancelled) return
        const names = Array.from(new Set((data ?? []).map((r) => r.bank_name).filter(Boolean)))
        setActivePsd2Banks(names)
      })
    return () => {
      cancelled = true
    }
  }, [company?.id])

  const steps = parseResult?.format === 'generic_csv' ? BANK_STEPS_WITH_MAPPING : BANK_STEPS
  const currentStepIndex = steps.indexOf(bankStep)
  const progress = ((currentStepIndex + 1) / steps.length) * 100

  const handleFileSelect = useCallback(async (file: File, formatOverride?: BankFileFormatId) => {
    setBankError(null)
    setBankErrorTitle(null)
    setBankIsLoading(true)

    try {
      const formData = new FormData()
      formData.append('file', file)
      if (formatOverride) {
        formData.append('format', formatOverride)
      }

      const res = await fetch('/api/import/bank-file/parse', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()

      if (!res.ok) {
        // Structured error envelope: { error: { code, message, message_en, details } }
        const err = data?.error
        if (err && typeof err === 'object') {
          if (err.code === 'BANK_FILE_DUPLICATE') {
            const importedAt = err.details?.importedAt ? formatDate(err.details.importedAt) : null
            const count = typeof err.details?.importedCount === 'number' ? err.details.importedCount : null
            const when = importedAt
              ? ` ${importedAt}${count !== null ? ` (${count} transaktioner)` : ''}`
              : ''
            setBankErrorTitle('Filen är redan importerad')
            setBankError(
              `Den här filen är redan importerad${when}. Transaktionerna finns redan under Transaktioner. ` +
                'Exportera en ny fil från banken om du vill lägga till fler transaktioner.'
            )
          } else {
            setBankError(err.message || 'Kunde inte läsa filen')
          }
        } else {
          setBankError(typeof err === 'string' ? err : 'Kunde inte läsa filen')
        }
        return
      }

      setParseResult(data.data.parse_result)
      setDetectedFormat(data.data.detected_format)
      setDetectedFormatName(data.data.detected_format_name)
      setFileHash(data.data.file_hash)
      setFilename(data.data.filename)

      // Read raw file content for CSV preview
      const text = await file.text()
      setRawFileContent(text)

      const txCount = data.data.parse_result.transactions.length
      if (data.data.parse_result.format === 'generic_csv') {
        // Auto-detect failed or user picked "Annan CSV" — always route to manual column mapping.
        // Default mapping rarely matches, so advance regardless of tx count.
        setBankStep('column_mapping')
      } else if (txCount > 0) {
        setBankStep('preview')
        toast({
          title: 'Fil analyserad',
          description: `${txCount} transaktioner hittades`,
        })
      } else {
        // Format detected but no transactions parsed — parser couldn't extract rows
        setBankError('Filen kunde läsas men inga transaktioner hittades. Kontrollera att filen innehåller transaktionsdata och inte bara rubriker.')
      }
    } catch (err) {
      setBankError(err instanceof Error ? err.message : 'Kunde inte läsa filen')
    } finally {
      setBankIsLoading(false)
    }
  }, [toast])

  const handleColumnMappingConfirm = useCallback(async (mapping: GenericCSVColumnMapping) => {
    // Re-parse with mapping via the generic CSV parser
    const { parseGenericCSV } = await import('@/lib/import/bank-file/formats/generic-csv')
    const result = parseGenericCSV(rawFileContent, mapping)
    setParseResult(result)
    setBankStep('confirm')
  }, [rawFileContent])

  const handleExecuteImport = useCallback(async (options: { skip_duplicates: boolean; auto_categorize: boolean; settlement_account?: string }) => {
    if (!parseResult) return

    setBankIsLoading(true)
    setBankError(null)

    try {
      const res = await fetch('/api/import/bank-file/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactions: parseResult.transactions,
          format: parseResult.format,
          filename,
          file_hash: fileHash,
          ...options,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setBankError(data.error || 'Importen misslyckades')
        return
      }

      setIngestResult(data.data)
      setBankStep('result')

      toast({
        title: 'Import genomförd',
        description: `${data.data.imported} transaktioner importerades`,
      })
    } catch (err) {
      setBankError(err instanceof Error ? err.message : 'Importen misslyckades')
    } finally {
      setBankIsLoading(false)
    }
  }, [parseResult, filename, fileHash, toast])

  const handleNewImport = () => {
    setBankStep('upload')
    setParseResult(null)
    setDetectedFormat(null)
    setDetectedFormatName(null)
    setFileHash('')
    setFilename('')
    setIngestResult(null)
    setBankError(null)
    setBankErrorTitle(null)
    setRawFileContent('')
  }

  return (
    <div className="space-y-6">
      {/* Status chip for at-a-glance "auto-sync is healthy / stale / needs attention" */}
      <BankSyncStatusChip />

      {/* Overlap warning — active PSD2 means file import will likely create
          duplicates of transactions the nightly sync already covers. */}
      {activePsd2Banks.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div className="flex-1 text-sm">
            <p className="font-medium">
              {tTx('import_psd2_active_warning_title', { bankName: activePsd2Banks.join(', ') })}
            </p>
            <p className="mt-1 text-muted-foreground">
              {tTx('import_psd2_active_warning_body')}
            </p>
          </div>
        </div>
      )}

      {/* Progress */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="sm:hidden text-primary font-medium">
                Steg {currentStepIndex + 1}/{steps.length}: {BANK_STEP_LABELS[bankStep]}
              </span>
              {steps.map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    'hidden sm:inline',
                    i <= currentStepIndex ? 'text-primary font-medium' : 'text-muted-foreground'
                  )}
                >
                  {BANK_STEP_LABELS[s]}
                </span>
              ))}
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        </CardContent>
      </Card>

      {/* Step content */}
      {bankStep === 'upload' && (
        <BankFileUploadStep
          onFileSelect={handleFileSelect}
          isLoading={bankIsLoading}
          error={bankError}
          errorTitle={bankErrorTitle}
          detectedFormat={detectedFormat}
          detectedFormatName={detectedFormatName}
        />
      )}

      {bankStep === 'preview' && parseResult && (
        <BankFilePreviewStep
          parseResult={parseResult}
          onContinue={() => {
            if (parseResult.format === 'generic_csv') {
              setBankStep('column_mapping')
            } else {
              setBankStep('confirm')
            }
          }}
          onBack={() => setBankStep('upload')}
        />
      )}

      {bankStep === 'column_mapping' && (
        <BankFileColumnMappingStep
          rawFileContent={rawFileContent}
          onConfirm={handleColumnMappingConfirm}
          onBack={() => setBankStep('upload')}
        />
      )}

      {bankStep === 'confirm' && parseResult && (
        <BankFileConfirmStep
          parseResult={parseResult}
          onExecute={handleExecuteImport}
          onBack={() => {
            if (parseResult.format === 'generic_csv') {
              setBankStep('column_mapping')
            } else {
              setBankStep('preview')
            }
          }}
          isLoading={bankIsLoading}
        />
      )}

      {bankStep === 'result' && ingestResult && (
        <BankFileResultStep
          result={ingestResult}
          onNewImport={handleNewImport}
        />
      )}
    </div>
  )
}

// ============================================================
// SIE Import Wizard (unchanged, extracted into component)
// ============================================================

const SIE_STEP_LABELS: Record<ImportWizardStep, string> = {
  upload: 'Ladda upp',
  preview: 'Förhandsgranskning',
  mapping: 'Kontomappning',
  review: 'Bekräfta',
  result: 'Resultat',
}

function SIEImportWizard() {
  const { toast } = useToast()

  const [step, setStep] = useState<ImportWizardStep>('upload')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorType, setErrorType] = useState<'duplicate' | 'duplicate_period' | 'validation' | 'parse' | 'network' | undefined>()
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [validationWarnings, setValidationWarnings] = useState<string[]>([])
  const [duplicateImportId, setDuplicateImportId] = useState<string | null>(null)
  const [isReplacing, setIsReplacing] = useState(false)

  const [file, setFile] = useState<File | null>(null)
  const [, setParsed] = useState<ParsedSIEFile | null>(null)
  const [mappings, setMappings] = useState<AccountMapping[]>([])
  const [basAccounts, setBasAccounts] = useState<BASAccount[]>([])
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [issues, setIssues] = useState<ParseIssue[]>([])
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [, setSieAccounts] = useState<{ number: string; name: string }[]>([])
  const [isCreatingAccounts, setIsCreatingAccounts] = useState(false)

  // Skip the mapping step when all accounts are already mapped
  const hasUnmapped = mappings.some((m) => !m.targetAccount)
  const sieSteps: ImportWizardStep[] = hasUnmapped
    ? ['upload', 'preview', 'mapping', 'review', 'result']
    : ['upload', 'preview', 'review', 'result']

  const currentStepIndex = sieSteps.indexOf(step)
  const progress = ((currentStepIndex + 1) / sieSteps.length) * 100

  const handleFileSelect = useCallback(async (selectedFile: File) => {
    setFile(selectedFile)
    setError(null)
    setErrorType(undefined)
    setValidationErrors([])
    setValidationWarnings([])
    setIsLoading(true)

    try {
      const formData = new FormData()
      formData.append('file', selectedFile)

      const res = await fetch('/api/import/sie/parse', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()

      if (!res.ok) {
        const code = data?.error?.code as string | undefined
        const message = getErrorMessage(data)
        const details = (data?.error?.details ?? {}) as {
          importId?: string
          errors?: string[]
          warnings?: string[]
        }
        if (code === 'SIE_DUPLICATE_FILE' || code === 'SIE_DUPLICATE_PERIOD') {
          const isPeriod = code === 'SIE_DUPLICATE_PERIOD'
          setErrorType(isPeriod ? 'duplicate_period' : 'duplicate')
          setError(message)
          if (details.importId) {
            setDuplicateImportId(details.importId)
          }
          toast({
            title: isPeriod ? 'Överlappande räkenskapsår' : 'Filen har redan importerats',
            description: message,
            variant: 'destructive',
          })
        } else if (code === 'SIE_PARSE_VALIDATION_FAILED') {
          setErrorType('validation')
          setError(message)
          setValidationErrors(details.errors || [])
          setValidationWarnings(details.warnings || [])
          toast({
            title: 'Valideringsfel i SIE-filen',
            description: `${(details.errors || []).length} fel hittades som måste åtgärdas.`,
            variant: 'destructive',
          })
        } else {
          setErrorType('parse')
          setError(message)
          toast({ title: 'Kunde inte läsa filen', description: message, variant: 'destructive' })
        }
        return
      }

      setParsed({
        header: data.parsed.header,
        accounts: data.parsed.accounts,
        openingBalances: [],
        closingBalances: [],
        resultBalances: [],
        vouchers: [],
        issues: data.parsed.issues,
        stats: data.parsed.stats,
      })
      setMappings(data.mappings)
      setPreview(data.preview)
      setIssues(data.parsed.issues)
      setSieAccounts(data.parsed.accounts)

      const accountsRes = await fetch('/api/bookkeeping/accounts')
      if (accountsRes.ok) {
        const accountsData = await accountsRes.json()
        setBasAccounts(accountsData.data || [])
      }

      setStep('preview')

      toast({
        title: 'Fil analyserad',
        description: `${data.parsed.stats.totalAccounts} konton och ${data.parsed.stats.totalVouchers} verifikationer hittades`,
      })
    } catch (err) {
      const isNetworkError = err instanceof TypeError && (err.message === 'Failed to fetch' || err.message.includes('NetworkError'))
      const message = isNetworkError
        ? 'Kunde inte nå servern. Kontrollera din internetanslutning och försök igen.'
        : err instanceof Error ? err.message : 'Ett oväntat fel uppstod.'
      setErrorType(isNetworkError ? 'network' : 'parse')
      setError(message)
      toast({ title: isNetworkError ? 'Anslutningsfel' : 'Ett fel uppstod', description: message, variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [toast])

  const handleUndo = useCallback(async (importId: string) => {
    setIsLoading(true)
    try {
      const res = await fetch(`/api/import/sie/${importId}/undo`, { method: 'DELETE' })
      const data = await res.json()

      if (!res.ok) {
        toast({ title: 'Kunde inte ångra import', description: getErrorMessage(data), variant: 'destructive' })
        return
      }

      toast({
        title: 'Import ångrad',
        description: `${data.deletedEntries} verifikation${data.deletedEntries === 1 ? '' : 'er'} raderades.`,
      })

      // Reset wizard to upload step so the user can re-import a corrected file
      setStep('upload')
      setFile(null)
      setParsed(null)
      setMappings([])
      setPreview(null)
      setIssues([])
      setImportResult(null)
      setError(null)
      setErrorType(undefined)
      setValidationErrors([])
      setValidationWarnings([])
      setDuplicateImportId(null)
      setSieAccounts([])
    } catch {
      toast({ title: 'Anslutningsfel', description: 'Kunde inte nå servern.', variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [toast])

  const handleReplace = useCallback(async (importId: string) => {
    if (!file) return

    setIsReplacing(true)
    try {
      const res = await fetch(`/api/import/sie/${importId}/replace`, { method: 'POST' })
      const data = await res.json()

      if (!res.ok) {
        toast({ title: 'Kunde inte ersätta import', description: getErrorMessage(data), variant: 'destructive' })
        return
      }

      toast({
        title: 'Import ersatt',
        description: `${data.deletedEntries} verifikation${data.deletedEntries === 1 ? '' : 'er'} raderades. Importerar ny fil...`,
      })

      // Clear error state and re-trigger the file upload
      setError(null)
      setErrorType(undefined)
      setDuplicateImportId(null)

      // Small delay so the user sees the success toast before re-upload starts
      await new Promise(resolve => setTimeout(resolve, 500))
      handleFileSelect(file)
    } catch {
      toast({ title: 'Anslutningsfel', description: 'Kunde inte nå servern.', variant: 'destructive' })
    } finally {
      setIsReplacing(false)
    }
  }, [file, handleFileSelect, toast])

  const handleMappingChange = useCallback((sourceAccount: string, targetAccount: string, targetName: string) => {
    setMappings((prev) => applyMappingOverride(prev, sourceAccount, targetAccount, targetName))

    setPreview((prev) => {
      if (!prev) return prev
      const updatedMappings = applyMappingOverride(mappings, sourceAccount, targetAccount, targetName)
      const mapped = updatedMappings.filter((m) => m.targetAccount).length
      const unmapped = updatedMappings.length - mapped
      const lowConfidence = updatedMappings.filter((m) => m.targetAccount && m.confidence < 0.7).length

      return {
        ...prev,
        mappingStatus: {
          ...prev.mappingStatus,
          mapped,
          unmapped,
          lowConfidence,
        },
      }
    })
  }, [mappings])

  const missingAccounts = mappings
    .filter((m) => !m.targetAccount)
    .map((m) => ({ number: m.sourceAccount, name: m.sourceName }))

  const handleCreateAccounts = useCallback(async () => {
    if (missingAccounts.length === 0) return

    setIsCreatingAccounts(true)

    try {
      const res = await fetch('/api/import/sie/create-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: missingAccounts }),
      })

      const data = await res.json()

      if (!res.ok) {
        toast({ title: 'Kunde inte skapa konton', description: getErrorMessage(data), variant: 'destructive' })
        return
      }

      toast({ title: 'Konton skapade', description: `${data.created} nya konton har lagts till i din kontoplan` })

      // Optimistically update mappings: mark created accounts as self-mapped
      const createdSet = new Set(missingAccounts.map(a => a.number))
      setMappings(prev => prev.map(m =>
        !m.targetAccount && createdSet.has(m.sourceAccount)
          ? { ...m, targetAccount: m.sourceAccount, targetName: m.sourceName, confidence: 1.0 }
          : m
      ))
      setPreview(prev => {
        if (!prev) return prev
        const newMapped = prev.mappingStatus.mapped + createdSet.size
        return {
          ...prev,
          mappingStatus: {
            ...prev.mappingStatus,
            mapped: newMapped,
            unmapped: Math.max(0, prev.mappingStatus.unmapped - createdSet.size),
          },
        }
      })

      // Also refresh BAS accounts list
      const accountsRes = await fetch('/api/bookkeeping/accounts')
      if (accountsRes.ok) {
        const accountsData = await accountsRes.json()
        setBasAccounts(accountsData.data || [])
      }
    } catch (err) {
      toast({ title: 'Kunde inte skapa konton', description: err instanceof Error ? err.message : 'Försök igen.', variant: 'destructive' })
    } finally {
      setIsCreatingAccounts(false)
    }
  }, [missingAccounts, toast])

  const handleExecuteImport = useCallback(async (options: ImportExecuteOptions) => {
    if (!file) { setError('No file selected'); return }

    setIsLoading(true)
    setError(null)

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('mappings', JSON.stringify(mappings))
      formData.append('options', JSON.stringify(options))

      const res = await fetch('/api/import/sie/execute', { method: 'POST', body: formData })
      const data = await res.json()

      if (!res.ok) {
        const code = data?.error?.code as string | undefined
        const message = getErrorMessage(data)
        const failedResult = data?.error?.details?.result as typeof data.result | undefined

        if (code === 'SIE_DUPLICATE_FILE' || code === 'SIE_DUPLICATE_PERIOD') {
          setError(message)
          toast({ title: 'Filen har redan importerats', description: message, variant: 'destructive' })
          return
        }
        if (failedResult) {
          setImportResult(failedResult)
        } else {
          setError(message)
          toast({ title: 'Import misslyckades', description: message, variant: 'destructive' })
          return
        }
      } else {
        setImportResult(data.result)
      }

      setStep('result')

      if (data.result?.success) {
        const created = data.result.journalEntriesCreated
        const skipped = data.result.details?.skippedVouchers?.total || 0
        toast({
          title: 'Import genomförd',
          description: `${created} verifikationer skapades${skipped > 0 ? ` (${skipped} hoppades över)` : ''}`,
        })
      } else if (data.result && !data.result.success) {
        toast({
          title: 'Import slutförd med problem',
          description: `${data.result.errors?.length || 0} fel uppstod under importen. Se resultatet för detaljer.`,
          variant: 'destructive',
        })
      }
    } catch (err) {
      const isNetworkError = err instanceof TypeError && (err.message === 'Failed to fetch' || err.message.includes('NetworkError'))
      const msg = isNetworkError
        ? 'Tappade anslutningen till servern under importen. Kontrollera din internetanslutning och se om importen genomfördes under Bokföring.'
        : err instanceof Error ? err.message : 'Ett oväntat fel uppstod.'
      setError(msg)
      toast({ title: 'Import avbröts', description: msg, variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [file, mappings, toast])

  const goToStep = (targetStep: ImportWizardStep) => { setStep(targetStep); setError(null); setValidationErrors([]); setValidationWarnings([]) }
  const goBack = () => { const i = sieSteps.indexOf(step); if (i > 0) setStep(sieSteps[i - 1]) }

  const handleNewImport = () => {
    setStep('upload'); setFile(null); setParsed(null); setMappings([])
    setPreview(null); setIssues([]); setImportResult(null); setError(null); setErrorType(undefined)
    setValidationErrors([]); setValidationWarnings([]); setDuplicateImportId(null)
    setSieAccounts([]); setIsCreatingAccounts(false)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="sm:hidden text-primary font-medium">
                Steg {currentStepIndex + 1}/{sieSteps.length}: {SIE_STEP_LABELS[step]}
              </span>
              {sieSteps.map((s, i) => (
                <span key={s} className={cn(
                  'hidden sm:inline',
                  i <= currentStepIndex ? 'text-primary font-medium' : 'text-muted-foreground'
                )}>
                  {SIE_STEP_LABELS[s]}
                </span>
              ))}
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        </CardContent>
      </Card>

      {step === 'upload' && <SIEUploadStep onFileSelect={handleFileSelect} isLoading={isLoading} error={error} errorType={errorType} validationErrors={validationErrors} validationWarnings={validationWarnings} duplicateImportId={duplicateImportId} onReplace={handleReplace} isReplacing={isReplacing} />}
      {step === 'preview' && preview && (
        <SIEPreviewStep preview={preview} issues={issues} missingAccounts={missingAccounts}
          onCreateAccounts={handleCreateAccounts} isCreatingAccounts={isCreatingAccounts}
          onContinue={() => goToStep(hasUnmapped ? 'mapping' : 'review')} onBack={goBack} />
      )}
      {step === 'mapping' && (
        <AccountMappingStep mappings={mappings} basAccounts={basAccounts}
          onMappingChange={handleMappingChange} onContinue={() => goToStep('review')} onBack={goBack} />
      )}
      {step === 'review' && preview && (
        <ImportReviewStep preview={preview} mappings={mappings}
          onExecute={handleExecuteImport} onBack={goBack} isLoading={isLoading} />
      )}
      {step === 'result' && importResult && <ImportResultStep result={importResult} onNewImport={handleNewImport} onUndo={handleUndo} />}
    </div>
  )
}

// ============================================================
// Opening Balance Flow (entity = "opening_balance" inside CSVDataImportWizard)
// ============================================================

type OpeningBalanceStep = 'upload' | 'column_mapping' | 'edit' | 'period' | 'result'

const OB_STEP_LABELS: Record<OpeningBalanceStep, string> = {
  upload: 'Ladda upp',
  column_mapping: 'Kolumnmappning',
  edit: 'Granska',
  period: 'Period',
  result: 'Resultat',
}

function OpeningBalanceFlow() {
  const { toast } = useToast()

  const [obStep, setObStep] = useState<OpeningBalanceStep>('upload')
  const [obIsLoading, setObIsLoading] = useState(false)
  const [obError, setObError] = useState<string | null>(null)
  const [obFile, setObFile] = useState<File | null>(null)
  const [parseResult, setParseResult] = useState<OpeningBalanceParseResult | null>(null)
  const [editedRows, setEditedRows] = useState<{
    id: string; account_number: string; account_name: string
    debit_amount: number; credit_amount: number
  }[]>([])
  const [executeResult, setExecuteResult] = useState<OpeningBalanceExecuteResult | null>(null)

  // Determine steps — skip column mapping if confidence >= 0.8
  const needsMapping = parseResult && parseResult.detected_columns.confidence < 0.8
  const steps: OpeningBalanceStep[] = needsMapping
    ? ['upload', 'column_mapping', 'edit', 'period', 'result']
    : ['upload', 'edit', 'period', 'result']
  const currentStepIndex = steps.indexOf(obStep)
  const progress = ((currentStepIndex + 1) / steps.length) * 100

  const handleFileSelect = useCallback(async (file: File) => {
    setObError(null)
    setObIsLoading(true)
    setObFile(file)

    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch('/api/import/opening-balance/parse', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()

      if (!res.ok) {
        setObError(data.error || 'Kunde inte läsa filen')
        return
      }

      const result: OpeningBalanceParseResult = data.data
      setParseResult(result)

      if (result.rows.length === 0) {
        setObError('Inga konton med belopp hittades i filen. Kontrollera att filen innehåller kontonummer och belopp.')
        return
      }

      toast({
        title: 'Fil analyserad',
        description: `${result.rows.length} konton hittades`,
      })

      // Skip column mapping if confidence >= 0.8
      if (result.detected_columns.confidence < 0.8) {
        setObStep('column_mapping')
      } else {
        setObStep('edit')
      }
    } catch (err) {
      setObError(err instanceof Error ? err.message : 'Kunde inte läsa filen')
    } finally {
      setObIsLoading(false)
    }
  }, [toast])

  const handleColumnMappingConfirm = useCallback(async (columns: DetectedColumns) => {
    if (!obFile) return

    setObIsLoading(true)
    setObError(null)

    try {
      const formData = new FormData()
      formData.append('file', obFile)
      formData.append('column_overrides', JSON.stringify(columns))

      const res = await fetch('/api/import/opening-balance/parse', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()

      if (!res.ok) {
        setObError(data.error || 'Kunde inte läsa filen med de valda kolumnerna')
        return
      }

      setParseResult(data.data)
      setObStep('edit')
    } catch (err) {
      setObError(err instanceof Error ? err.message : 'Kunde inte läsa filen')
    } finally {
      setObIsLoading(false)
    }
  }, [obFile])

  const handleEditContinue = useCallback((rows: typeof editedRows) => {
    setEditedRows(rows)
    setObStep('period')
  }, [])

  const handleExecute = useCallback(async (fiscalPeriodId: string) => {
    setObIsLoading(true)
    setObError(null)

    try {
      const res = await fetch('/api/import/opening-balance/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiscal_period_id: fiscalPeriodId,
          lines: editedRows.map((r) => ({
            account_number: r.account_number,
            debit_amount: r.debit_amount,
            credit_amount: r.credit_amount,
          })),
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        if (res.status === 409) {
          setObError(data.error || 'Perioden har redan ingående balanser')
        } else {
          setObError(data.error || 'Importen misslyckades')
        }
        return
      }

      setExecuteResult(data.data)
      setObStep('result')

      if (data.data.success) {
        toast({
          title: 'Ingående balanser bokförda',
          description: `${data.data.lines_created} kontorader skapades`,
        })
      }
    } catch (err) {
      setObError(err instanceof Error ? err.message : 'Importen misslyckades')
    } finally {
      setObIsLoading(false)
    }
  }, [editedRows, toast])

  const handleNewImport = () => {
    setObStep('upload')
    setObFile(null)
    setParseResult(null)
    setEditedRows([])
    setExecuteResult(null)
    setObError(null)
  }

  return (
    <div className="space-y-6">
      {/* Progress */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="sm:hidden text-primary font-medium">
                Steg {currentStepIndex + 1}/{steps.length}: {OB_STEP_LABELS[obStep]}
              </span>
              {steps.map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    'hidden sm:inline',
                    i <= currentStepIndex ? 'text-primary font-medium' : 'text-muted-foreground',
                  )}
                >
                  {OB_STEP_LABELS[s]}
                </span>
              ))}
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        </CardContent>
      </Card>

      {/* Step content */}
      {obStep === 'upload' && (
        <OpeningBalanceUploadStep
          onFileSelect={handleFileSelect}
          isLoading={obIsLoading}
          error={obError}
        />
      )}

      {obStep === 'column_mapping' && parseResult && (
        <OpeningBalanceColumnMappingStep
          headers={parseResult.headers}
          previewRows={parseResult.preview_rows}
          detectedColumns={parseResult.detected_columns}
          onConfirm={handleColumnMappingConfirm}
          onBack={() => setObStep('upload')}
        />
      )}

      {obStep === 'edit' && parseResult && (
        <OpeningBalanceEditStep
          rows={parseResult.rows}
          onContinue={handleEditContinue}
          onBack={() => {
            if (needsMapping) {
              setObStep('column_mapping')
            } else {
              setObStep('upload')
            }
          }}
        />
      )}

      {obStep === 'period' && (
        <OpeningBalancePeriodStep
          rows={editedRows}
          onExecute={handleExecute}
          onBack={() => setObStep('edit')}
          isLoading={obIsLoading}
          error={obError}
        />
      )}

      {obStep === 'result' && executeResult && (
        <OpeningBalanceResultStep
          result={executeResult}
          onNewImport={handleNewImport}
        />
      )}
    </div>
  )
}

// ============================================================
// Customers Flow (entity = "customers" inside CSVDataImportWizard)
// ============================================================

type RegisterStep = 'upload' | 'column_mapping' | 'edit' | 'result'

const REGISTER_STEP_LABELS: Record<RegisterStep, string> = {
  upload: 'Ladda upp',
  column_mapping: 'Kolumnmappning',
  edit: 'Granska',
  result: 'Resultat',
}

const CUSTOMER_COLUMN_SPECS: RegisterColumnSpec<keyof DetectedCustomerColumns>[] = [
  { key: 'name_col', label: 'Namn', required: true },
  { key: 'org_number_col', label: 'Org-/personnummer', required: false },
  { key: 'customer_type_col', label: 'Kundtyp', required: false },
  { key: 'email_col', label: 'E-post', required: false },
  { key: 'phone_col', label: 'Telefon', required: false },
  { key: 'address_line1_col', label: 'Adress', required: false },
  { key: 'address_line2_col', label: 'Adress rad 2', required: false },
  { key: 'postal_code_col', label: 'Postnummer', required: false },
  { key: 'city_col', label: 'Ort', required: false },
  { key: 'country_col', label: 'Land', required: false },
  { key: 'vat_number_col', label: 'VAT-nummer', required: false },
  { key: 'payment_terms_col', label: 'Betalningsvillkor (dagar)', required: false },
  { key: 'notes_col', label: 'Anteckning', required: false },
]

function columnsToMapping<K extends string>(
  cols: { readonly [key: string]: unknown },
  specs: RegisterColumnSpec<K>[],
): Record<K, number | null> {
  const out = {} as Record<K, number | null>
  for (const spec of specs) {
    const v = cols[spec.key as string]
    out[spec.key] = typeof v === 'number' ? v : null
  }
  return out
}

function CustomersFlow() {
  const { toast } = useToast()

  const [step, setStep] = useState<RegisterStep>('upload')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [parseResult, setParseResult] = useState<CustomerImportParseResult | null>(null)
  const [executeResult, setExecuteResult] = useState<RegisterResult | null>(null)

  const needsMapping = parseResult && parseResult.detected_columns.confidence < 0.8
  const steps: RegisterStep[] = needsMapping
    ? ['upload', 'column_mapping', 'edit', 'result']
    : ['upload', 'edit', 'result']
  const currentStepIndex = steps.indexOf(step)
  const progress = ((currentStepIndex + 1) / steps.length) * 100

  const handleFileSelect = useCallback(async (selectedFile: File) => {
    setError(null)
    setIsLoading(true)
    setFile(selectedFile)

    try {
      const formData = new FormData()
      formData.append('file', selectedFile)

      const res = await fetch('/api/import/customers/parse', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error?.message_sv || data.error?.message || data.error || 'Kunde inte läsa filen')
        return
      }

      const result = data.data as CustomerImportParseResult
      setParseResult(result)

      if (result.rows.length === 0) {
        setError('Inga giltiga kundrader hittades. Kontrollera att filen innehåller en namnkolumn.')
        return
      }

      toast({
        title: 'Fil analyserad',
        description: `${result.rows.length} kunder hittades${result.duplicate_count > 0 ? ` (${result.duplicate_count} matchar befintliga)` : ''}`,
      })

      setStep(result.detected_columns.confidence < 0.8 ? 'column_mapping' : 'edit')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunde inte läsa filen')
    } finally {
      setIsLoading(false)
    }
  }, [toast])

  const handleColumnMappingConfirm = useCallback(async (
    mapping: Record<keyof DetectedCustomerColumns, number | null>,
  ) => {
    if (!file) return
    setIsLoading(true)
    setError(null)

    try {
      const overrides: DetectedCustomerColumns = {
        name_col: mapping.name_col ?? 0,
        org_number_col: mapping.org_number_col,
        customer_type_col: mapping.customer_type_col,
        email_col: mapping.email_col,
        phone_col: mapping.phone_col,
        address_line1_col: mapping.address_line1_col,
        address_line2_col: mapping.address_line2_col,
        postal_code_col: mapping.postal_code_col,
        city_col: mapping.city_col,
        country_col: mapping.country_col,
        vat_number_col: mapping.vat_number_col,
        payment_terms_col: mapping.payment_terms_col,
        notes_col: mapping.notes_col,
        confidence: 1,
      }

      const formData = new FormData()
      formData.append('file', file)
      formData.append('column_overrides', JSON.stringify(overrides))

      const res = await fetch('/api/import/customers/parse', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error?.message_sv || data.error?.message || 'Kunde inte tolka filen med de valda kolumnerna')
        return
      }

      setParseResult(data.data)
      setStep('edit')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunde inte läsa filen')
    } finally {
      setIsLoading(false)
    }
  }, [file])

  const handleExecute = useCallback(async (
    rows: AnnotatedCustomerRow[],
    updateDuplicates: boolean,
  ) => {
    setIsLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/import/customers/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: rows.map(({ duplicate_match: _dup, is_valid: _v, validation_errors: _ve, ...rest }) => rest),
          update_duplicates: updateDuplicates,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error?.message_sv || data.error?.message || 'Importen misslyckades')
        return
      }

      setExecuteResult(data.data as RegisterResult)
      setStep('result')

      const r = data.data as RegisterResult
      toast({
        title: r.success ? 'Kunder importerade' : 'Importen slutfördes med fel',
        description: `${r.created} skapade, ${r.updated} uppdaterade, ${r.skipped} hoppade över${r.failed > 0 ? `, ${r.failed} misslyckades` : ''}`,
        variant: r.success ? 'default' : 'destructive',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Importen misslyckades')
    } finally {
      setIsLoading(false)
    }
  }, [toast])

  const handleNewImport = () => {
    setStep('upload')
    setFile(null)
    setParseResult(null)
    setExecuteResult(null)
    setError(null)
  }

  const initialMapping = parseResult
    ? columnsToMapping<keyof DetectedCustomerColumns>(parseResult.detected_columns as unknown as { [key: string]: unknown }, CUSTOMER_COLUMN_SPECS)
    : null

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="sm:hidden text-primary font-medium">
                Steg {currentStepIndex + 1}/{steps.length}: {REGISTER_STEP_LABELS[step]}
              </span>
              {steps.map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    'hidden sm:inline',
                    i <= currentStepIndex ? 'text-primary font-medium' : 'text-muted-foreground',
                  )}
                >
                  {REGISTER_STEP_LABELS[s]}
                </span>
              ))}
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        </CardContent>
      </Card>

      {step === 'upload' && (
        <RegisterUploadStep
          entity="customers"
          onFileSelect={handleFileSelect}
          isLoading={isLoading}
          error={error}
        />
      )}

      {step === 'column_mapping' && parseResult && initialMapping && (
        <RegisterColumnMappingStep<keyof DetectedCustomerColumns>
          headers={parseResult.headers}
          previewRows={parseResult.preview_rows}
          specs={CUSTOMER_COLUMN_SPECS}
          initial={initialMapping}
          onConfirm={handleColumnMappingConfirm}
          onBack={() => setStep('upload')}
        />
      )}

      {step === 'edit' && parseResult && (
        <CustomersEditStep
          rows={parseResult.rows}
          onExecute={handleExecute}
          onBack={() => setStep(needsMapping ? 'column_mapping' : 'upload')}
          isLoading={isLoading}
          error={error}
        />
      )}

      {step === 'result' && executeResult && (
        <RegisterResultStep
          entity="customers"
          result={executeResult}
          onNewImport={handleNewImport}
        />
      )}
    </div>
  )
}

// ============================================================
// Suppliers Flow (entity = "suppliers" inside CSVDataImportWizard)
// ============================================================

const SUPPLIER_COLUMN_SPECS: RegisterColumnSpec<keyof DetectedSupplierColumns>[] = [
  { key: 'name_col', label: 'Namn', required: true },
  { key: 'org_number_col', label: 'Org-/personnummer', required: false },
  { key: 'supplier_type_col', label: 'Leverantörstyp', required: false },
  { key: 'email_col', label: 'E-post', required: false },
  { key: 'phone_col', label: 'Telefon', required: false },
  { key: 'address_line1_col', label: 'Adress', required: false },
  { key: 'address_line2_col', label: 'Adress rad 2', required: false },
  { key: 'postal_code_col', label: 'Postnummer', required: false },
  { key: 'city_col', label: 'Ort', required: false },
  { key: 'country_col', label: 'Land', required: false },
  { key: 'vat_number_col', label: 'VAT-nummer', required: false },
  { key: 'bankgiro_col', label: 'Bankgiro', required: false },
  { key: 'plusgiro_col', label: 'Plusgiro', required: false },
  { key: 'bank_account_col', label: 'Bankkonto', required: false },
  { key: 'iban_col', label: 'IBAN', required: false },
  { key: 'bic_col', label: 'BIC/SWIFT', required: false },
  { key: 'payment_terms_col', label: 'Betalningsvillkor (dagar)', required: false },
  { key: 'default_currency_col', label: 'Valuta', required: false },
  { key: 'notes_col', label: 'Anteckning', required: false },
]

function SuppliersFlow() {
  const { toast } = useToast()

  const [step, setStep] = useState<RegisterStep>('upload')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [parseResult, setParseResult] = useState<SupplierImportParseResult | null>(null)
  const [executeResult, setExecuteResult] = useState<RegisterResult | null>(null)

  const needsMapping = parseResult && parseResult.detected_columns.confidence < 0.8
  const steps: RegisterStep[] = needsMapping
    ? ['upload', 'column_mapping', 'edit', 'result']
    : ['upload', 'edit', 'result']
  const currentStepIndex = steps.indexOf(step)
  const progress = ((currentStepIndex + 1) / steps.length) * 100

  const handleFileSelect = useCallback(async (selectedFile: File) => {
    setError(null)
    setIsLoading(true)
    setFile(selectedFile)

    try {
      const formData = new FormData()
      formData.append('file', selectedFile)

      const res = await fetch('/api/import/suppliers/parse', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error?.message_sv || data.error?.message || data.error || 'Kunde inte läsa filen')
        return
      }

      const result = data.data as SupplierImportParseResult
      setParseResult(result)

      if (result.rows.length === 0) {
        setError('Inga giltiga leverantörsrader hittades. Kontrollera att filen innehåller en namnkolumn.')
        return
      }

      toast({
        title: 'Fil analyserad',
        description: `${result.rows.length} leverantörer hittades${result.duplicate_count > 0 ? ` (${result.duplicate_count} matchar befintliga)` : ''}`,
      })

      setStep(result.detected_columns.confidence < 0.8 ? 'column_mapping' : 'edit')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunde inte läsa filen')
    } finally {
      setIsLoading(false)
    }
  }, [toast])

  const handleColumnMappingConfirm = useCallback(async (
    mapping: Record<keyof DetectedSupplierColumns, number | null>,
  ) => {
    if (!file) return
    setIsLoading(true)
    setError(null)

    try {
      const overrides: DetectedSupplierColumns = {
        name_col: mapping.name_col ?? 0,
        org_number_col: mapping.org_number_col,
        supplier_type_col: mapping.supplier_type_col,
        email_col: mapping.email_col,
        phone_col: mapping.phone_col,
        address_line1_col: mapping.address_line1_col,
        address_line2_col: mapping.address_line2_col,
        postal_code_col: mapping.postal_code_col,
        city_col: mapping.city_col,
        country_col: mapping.country_col,
        vat_number_col: mapping.vat_number_col,
        bankgiro_col: mapping.bankgiro_col,
        plusgiro_col: mapping.plusgiro_col,
        bank_account_col: mapping.bank_account_col,
        iban_col: mapping.iban_col,
        bic_col: mapping.bic_col,
        payment_terms_col: mapping.payment_terms_col,
        default_currency_col: mapping.default_currency_col,
        notes_col: mapping.notes_col,
        confidence: 1,
      }

      const formData = new FormData()
      formData.append('file', file)
      formData.append('column_overrides', JSON.stringify(overrides))

      const res = await fetch('/api/import/suppliers/parse', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error?.message_sv || data.error?.message || 'Kunde inte tolka filen')
        return
      }

      setParseResult(data.data)
      setStep('edit')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunde inte läsa filen')
    } finally {
      setIsLoading(false)
    }
  }, [file])

  const handleExecute = useCallback(async (
    rows: AnnotatedSupplierRow[],
    updateDuplicates: boolean,
  ) => {
    setIsLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/import/suppliers/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: rows.map(({ duplicate_match: _dup, is_valid: _v, validation_errors: _ve, ...rest }) => rest),
          update_duplicates: updateDuplicates,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error?.message_sv || data.error?.message || 'Importen misslyckades')
        return
      }

      setExecuteResult(data.data as RegisterResult)
      setStep('result')

      const r = data.data as RegisterResult
      toast({
        title: r.success ? 'Leverantörer importerade' : 'Importen slutfördes med fel',
        description: `${r.created} skapade, ${r.updated} uppdaterade, ${r.skipped} hoppade över${r.failed > 0 ? `, ${r.failed} misslyckades` : ''}`,
        variant: r.success ? 'default' : 'destructive',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Importen misslyckades')
    } finally {
      setIsLoading(false)
    }
  }, [toast])

  const handleNewImport = () => {
    setStep('upload')
    setFile(null)
    setParseResult(null)
    setExecuteResult(null)
    setError(null)
  }

  const initialMapping = parseResult
    ? columnsToMapping<keyof DetectedSupplierColumns>(parseResult.detected_columns as unknown as { [key: string]: unknown }, SUPPLIER_COLUMN_SPECS)
    : null

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="sm:hidden text-primary font-medium">
                Steg {currentStepIndex + 1}/{steps.length}: {REGISTER_STEP_LABELS[step]}
              </span>
              {steps.map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    'hidden sm:inline',
                    i <= currentStepIndex ? 'text-primary font-medium' : 'text-muted-foreground',
                  )}
                >
                  {REGISTER_STEP_LABELS[s]}
                </span>
              ))}
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        </CardContent>
      </Card>

      {step === 'upload' && (
        <RegisterUploadStep
          entity="suppliers"
          onFileSelect={handleFileSelect}
          isLoading={isLoading}
          error={error}
        />
      )}

      {step === 'column_mapping' && parseResult && initialMapping && (
        <RegisterColumnMappingStep<keyof DetectedSupplierColumns>
          headers={parseResult.headers}
          previewRows={parseResult.preview_rows}
          specs={SUPPLIER_COLUMN_SPECS}
          initial={initialMapping}
          onConfirm={handleColumnMappingConfirm}
          onBack={() => setStep('upload')}
        />
      )}

      {step === 'edit' && parseResult && (
        <SuppliersEditStep
          rows={parseResult.rows}
          onExecute={handleExecute}
          onBack={() => setStep(needsMapping ? 'column_mapping' : 'upload')}
          isLoading={isLoading}
          error={error}
        />
      )}

      {step === 'result' && executeResult && (
        <RegisterResultStep
          entity="suppliers"
          result={executeResult}
          onNewImport={handleNewImport}
        />
      )}
    </div>
  )
}

// ============================================================
// Articles Flow (entity = "articles" inside CSVDataImportWizard)
// ============================================================

const ARTICLE_COLUMN_SPECS: RegisterColumnSpec<keyof DetectedArticleColumns>[] = [
  { key: 'name_col', label: 'Benämning', required: true },
  { key: 'article_number_col', label: 'Artikelnummer', required: false },
  { key: 'type_col', label: 'Typ (vara/tjänst)', required: false },
  { key: 'unit_col', label: 'Enhet', required: false },
  { key: 'price_col', label: 'Pris exkl moms', required: false },
  { key: 'vat_rate_col', label: 'Moms (%)', required: false },
  { key: 'revenue_account_col', label: 'Försäljningskonto', required: false },
  { key: 'cost_price_col', label: 'Inköpspris', required: false },
  { key: 'ean_col', label: 'EAN', required: false },
  { key: 'housework_type_col', label: 'ROT/RUT-arbetstyp', required: false },
  { key: 'name_en_col', label: 'Benämning (engelska)', required: false },
  { key: 'notes_col', label: 'Anteckning', required: false },
]

function ArticlesFlow() {
  const { toast } = useToast()

  const [step, setStep] = useState<RegisterStep>('upload')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [parseResult, setParseResult] = useState<ArticleImportParseResult | null>(null)
  const [executeResult, setExecuteResult] = useState<RegisterResult | null>(null)

  const needsMapping = parseResult && parseResult.detected_columns.confidence < 0.8
  const steps: RegisterStep[] = needsMapping
    ? ['upload', 'column_mapping', 'edit', 'result']
    : ['upload', 'edit', 'result']
  const currentStepIndex = steps.indexOf(step)
  const progress = ((currentStepIndex + 1) / steps.length) * 100

  const handleFileSelect = useCallback(async (selectedFile: File) => {
    setError(null)
    setIsLoading(true)
    setFile(selectedFile)

    try {
      const formData = new FormData()
      formData.append('file', selectedFile)

      const res = await fetch('/api/import/articles/parse', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error?.message_sv || data.error?.message || data.error || 'Kunde inte läsa filen')
        return
      }

      const result = data.data as ArticleImportParseResult
      setParseResult(result)

      if (result.rows.length === 0) {
        setError('Inga giltiga artiklar hittades. Kontrollera att filen innehåller en benämningskolumn.')
        return
      }

      toast({
        title: 'Fil analyserad',
        description: `${result.rows.length} artiklar hittades${result.duplicate_count > 0 ? ` (${result.duplicate_count} matchar befintliga)` : ''}`,
      })

      setStep(result.detected_columns.confidence < 0.8 ? 'column_mapping' : 'edit')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunde inte läsa filen')
    } finally {
      setIsLoading(false)
    }
  }, [toast])

  const handleColumnMappingConfirm = useCallback(async (
    mapping: Record<keyof DetectedArticleColumns, number | null>,
  ) => {
    if (!file) return
    setIsLoading(true)
    setError(null)

    try {
      const overrides: DetectedArticleColumns = {
        name_col: mapping.name_col ?? 0,
        article_number_col: mapping.article_number_col,
        name_en_col: mapping.name_en_col,
        type_col: mapping.type_col,
        unit_col: mapping.unit_col,
        price_col: mapping.price_col,
        vat_rate_col: mapping.vat_rate_col,
        revenue_account_col: mapping.revenue_account_col,
        cost_price_col: mapping.cost_price_col,
        ean_col: mapping.ean_col,
        housework_type_col: mapping.housework_type_col,
        notes_col: mapping.notes_col,
        confidence: 1,
      }

      const formData = new FormData()
      formData.append('file', file)
      formData.append('column_overrides', JSON.stringify(overrides))

      const res = await fetch('/api/import/articles/parse', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error?.message_sv || data.error?.message || 'Kunde inte tolka filen med de valda kolumnerna')
        return
      }

      setParseResult(data.data)
      setStep('edit')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunde inte läsa filen')
    } finally {
      setIsLoading(false)
    }
  }, [file])

  const handleExecute = useCallback(async (
    rows: AnnotatedArticleRow[],
    updateDuplicates: boolean,
  ) => {
    setIsLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/import/articles/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: rows.map(({ duplicate_match: _dup, is_valid: _v, validation_errors: _ve, vat_rate_adjusted: _vra, ...rest }) => rest),
          update_duplicates: updateDuplicates,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error?.message_sv || data.error?.message || 'Importen misslyckades')
        return
      }

      setExecuteResult(data.data as RegisterResult)
      setStep('result')

      const r = data.data as RegisterResult
      toast({
        title: r.success ? 'Artiklar importerade' : 'Importen slutfördes med fel',
        description: `${r.created} skapade, ${r.updated} uppdaterade, ${r.skipped} hoppade över${r.failed > 0 ? `, ${r.failed} misslyckades` : ''}`,
        variant: r.success ? 'default' : 'destructive',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Importen misslyckades')
    } finally {
      setIsLoading(false)
    }
  }, [toast])

  const handleNewImport = () => {
    setStep('upload')
    setFile(null)
    setParseResult(null)
    setExecuteResult(null)
    setError(null)
  }

  const initialMapping = parseResult
    ? columnsToMapping<keyof DetectedArticleColumns>(parseResult.detected_columns as unknown as { [key: string]: unknown }, ARTICLE_COLUMN_SPECS)
    : null

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="sm:hidden text-primary font-medium">
                Steg {currentStepIndex + 1}/{steps.length}: {REGISTER_STEP_LABELS[step]}
              </span>
              {steps.map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    'hidden sm:inline',
                    i <= currentStepIndex ? 'text-primary font-medium' : 'text-muted-foreground',
                  )}
                >
                  {REGISTER_STEP_LABELS[s]}
                </span>
              ))}
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        </CardContent>
      </Card>

      {step === 'upload' && (
        <RegisterUploadStep
          entity="articles"
          onFileSelect={handleFileSelect}
          isLoading={isLoading}
          error={error}
        />
      )}

      {step === 'column_mapping' && parseResult && initialMapping && (
        <RegisterColumnMappingStep<keyof DetectedArticleColumns>
          headers={parseResult.headers}
          previewRows={parseResult.preview_rows}
          specs={ARTICLE_COLUMN_SPECS}
          initial={initialMapping}
          onConfirm={handleColumnMappingConfirm}
          onBack={() => setStep('upload')}
        />
      )}

      {step === 'edit' && parseResult && (
        <ArticlesEditStep
          rows={parseResult.rows}
          onExecute={handleExecute}
          onBack={() => setStep(needsMapping ? 'column_mapping' : 'upload')}
          isLoading={isLoading}
          error={error}
        />
      )}

      {step === 'result' && executeResult && (
        <RegisterResultStep
          entity="articles"
          result={executeResult}
          onNewImport={handleNewImport}
        />
      )}
    </div>
  )
}

// ============================================================
// CSV/Excel Data Import Wizard — entity selector + sub-flow
// ============================================================

type CSVDataEntity = 'opening_balance' | 'customers' | 'suppliers' | 'articles'

const ENTITY_OPTIONS: { value: CSVDataEntity; label: string }[] = [
  { value: 'opening_balance', label: 'Ingående balanser' },
  { value: 'customers', label: 'Kunder' },
  { value: 'suppliers', label: 'Leverantörer' },
  { value: 'articles', label: 'Artiklar' },
]

function CSVDataImportWizard() {
  const [entity, setEntity] = useState<CSVDataEntity | null>('opening_balance')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        {ENTITY_OPTIONS.map((opt) => {
          const selected = entity === opt.value
          return (
            <div key={opt.value} className="relative">
              {selected && (
                <svg
                  aria-hidden
                  className="pointer-events-none absolute -inset-[3px] h-[calc(100%+6px)] w-[calc(100%+6px)] overflow-visible"
                >
                  <motion.rect
                    x="1"
                    y="1"
                    width="calc(100% - 2px)"
                    height="calc(100% - 2px)"
                    rx="8"
                    ry="8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.25"
                    strokeDasharray="3 4"
                    className="text-foreground/45"
                    animate={{ strokeDashoffset: [0, -14] }}
                    transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
                  />
                </svg>
              )}
              <button
                type="button"
                onClick={() => setEntity(opt.value)}
                aria-pressed={selected}
                className={cn(
                  'relative h-9 rounded-md border px-4 text-sm font-medium transition-colors',
                  selected
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border bg-card text-foreground hover:border-foreground/30 hover:bg-muted',
                )}
              >
                {opt.label}
              </button>
            </div>
          )
        })}
      </div>

      {entity === 'opening_balance' && <OpeningBalanceFlow key="ob-flow" />}
      {entity === 'customers' && <CustomersFlow key="cust-flow" />}
      {entity === 'suppliers' && <SuppliersFlow key="supp-flow" />}
      {entity === 'articles' && <ArticlesFlow key="art-flow" />}
    </div>
  )
}

// ============================================================
// PSD2 Bank Connection (inline, from Enable Banking extension)
// ============================================================

function PSD2ConnectWizard() {
  const { toast } = useToast()
  const supabase = createClient()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const { company } = useCompany()

  const [bankConnections, setBankConnections] = useState<BankConnection[]>([])
  const [syncingConnectionId, setSyncingConnectionId] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectingBankName, setConnectingBankName] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    fetchConnections()
  }, [])

  async function fetchConnections() {
    setIsLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    if (!company) return

    const { data: connections } = await supabase
      .from('bank_connections')
      .select('*')
      .eq('company_id', company.id)
      .order('created_at', { ascending: false })

    setBankConnections(connections || [])
    setIsLoading(false)
  }

  async function handleConnectBank(bank: Bank) {
    setIsConnecting(true)
    setConnectingBankName(bank.name)

    try {
      const response = await fetch('/api/extensions/ext/enable-banking/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aspsp_name: bank.name, aspsp_country: bank.country }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error)
      }

      window.location.href = data.authorization_url
    } catch (error) {
      toast({
        title: 'Kunde inte ansluta bank',
        description: error instanceof Error ? error.message : 'Försök igen.',
        variant: 'destructive',
      })
      setIsConnecting(false)
      setConnectingBankName(null)
    }
  }

  async function handleSyncTransactions(connectionId: string) {
    setSyncingConnectionId(connectionId)

    try {
      const response = await fetch('/api/extensions/ext/enable-banking/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error)
      }

      toast({
        title: 'Synkronisering klar',
        description: `${data.imported} nya transaktioner importerade`,
      })

      fetchConnections()
    } catch (error) {
      toast({
        title: 'Synkronisering misslyckades',
        description: error instanceof Error ? error.message : 'Försök igen.',
        variant: 'destructive',
      })
    }

    setSyncingConnectionId(null)
  }

  async function handleDisconnectBank(connectionId: string) {
    const ok = await confirm({
      title: 'Koppla bort bank?',
      description: 'PSD2-samtycket kommer återkallas. Befintliga transaktioner påverkas inte.',
      confirmLabel: 'Koppla bort',
      variant: 'warning',
    })
    if (!ok) return

    try {
      const response = await fetch('/api/extensions/ext/enable-banking/disconnect', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Disconnect failed')
      }

      toast({
        title: 'Bank bortkopplad',
        description: 'Bankanslutningen och PSD2-samtycket har återkallats',
      })
      fetchConnections()
    } catch (error) {
      toast({
        title: 'Kunde inte koppla bort bank',
        description: error instanceof Error ? error.message : 'Försök igen.',
        variant: 'destructive',
      })
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const activeConnections = bankConnections.filter((c) => c.status === 'active')

  return (
    <div className="space-y-6">
      <DestructiveConfirmDialog {...dialogProps} />

      {/* Connected banks */}
      {activeConnections.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Anslutna banker</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {activeConnections.map((connection) => (
              <BankConnectionStatus
                key={connection.id}
                connection={connection}
                onSync={handleSyncTransactions}
                onDisconnect={handleDisconnectBank}
                isSyncing={syncingConnectionId === connection.id}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Connect new bank */}
      <Card>
        <CardHeader>
          <CardTitle>Anslut din bank</CardTitle>
          <CardDescription>
            Välj din bank nedan för att koppla ditt konto via PSD2. Transaktioner synkas automatiskt varje dag.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BankSelector
            onConnect={handleConnectBank}
            isConnecting={isConnecting}
            connectingBankName={connectingBankName}
          />
        </CardContent>
      </Card>
    </div>
  )
}

// ============================================================
// Import Page with Selection Cards
// ============================================================

type ImportMode = null | 'psd2' | 'bank' | 'sie' | 'csv_data' | 'migration'

export default function ImportPage() {
  const { company } = useCompany()
  const [mode, setMode] = useState<ImportMode>(null)
  const [view, setView] = useState<'import' | 'export'>('import')
  const [userId, setUserId] = useState('')
  const [isSandbox, setIsSandbox] = useState(false)
  const [exportPeriodId, setExportPeriodId] = useState<string | null>(null)
  const [exportExcludeClosing, setExportExcludeClosing] = useState(true)
  const t = useTranslations('import')
  const router = useRouter()
  const hasCloudBackup = ENABLED_EXTENSION_IDS.has('cloud-backup')

  // Fetch authenticated user ID and sandbox status
  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      setUserId(user.id)
      if (!company) return
      supabase
        .from('company_settings')
        .select('is_sandbox')
        .eq('company_id', company.id)
        .single()
        .then(({ data }) => {
          if (data?.is_sandbox) setIsSandbox(true)
        })
    })
  }, [])

  // Sync mode + view from URL search params (reacts to client-side navigation changes)
  const searchParams = useSearchParams()
  useEffect(() => {
    // External imports (provider migration, PSD2 bank connection) need live
    // third-party credentials, so their deep links are ignored in the sandbox.
    // Manual file-import modes (bank file, CSV/Excel, SIE) stay reachable.
    const allowedModes = isSandbox
      ? ['bank', 'sie', 'csv_data']
      : ['psd2', 'bank', 'sie', 'csv_data', 'migration']
    if (!isSandbox && searchParams.get('migration')) {
      setMode('migration')
    } else {
      const modeParam = searchParams.get('mode')
      if (modeParam && allowedModes.includes(modeParam)) {
        setMode(modeParam as ImportMode)
      }
    }
    const viewParam = searchParams.get('view')
    if (viewParam === 'export' || viewParam === 'import') {
      setView(viewParam)
    }
  }, [isSandbox, searchParams])

  // Hash-based deep links (#cloud-backup, #sie-export) → switch to export tab and scroll
  useEffect(() => {
    if (typeof window === 'undefined') return
    const hash = window.location.hash
    if (hash === '#cloud-backup' || hash === '#sie-export') {
      setView('export')
      setTimeout(() => {
        document.querySelector(hash)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }, 50)
    }
  }, [])

  const handleViewChange = (next: string) => {
    if (next !== 'import' && next !== 'export') return
    setView(next)
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'export') params.set('view', 'export')
    else params.delete('view')
    const qs = params.toString()
    router.replace(qs ? `/import?${qs}` : '/import', { scroll: false })
  }
  // Extensions are active if compiled in — no runtime toggle check needed
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')
  const hasMigrationExtension = ENABLED_EXTENSION_IDS.has('arcim-migration')

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="font-display text-2xl md:text-3xl tracking-tight">
          {view === 'export' ? t('export_title') : t('title')}
        </h1>
        <p className="text-muted-foreground">
          {view === 'export' ? t('export_subtitle') : t('subtitle')}
        </p>
      </div>

      {mode === null && (
        <>
          {isSandbox && (
            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3">
              <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-sm text-muted-foreground">
                {t('sandbox_disabled')}
              </p>
            </div>
          )}

          <Tabs value={view} onValueChange={handleViewChange}>
            <TabsList className="grid w-full max-w-xs grid-cols-2">
              <TabsTrigger value="import">{t('tab_import')}</TabsTrigger>
              <TabsTrigger value="export">{t('tab_export')}</TabsTrigger>
            </TabsList>

            <TabsContent value="import" className="mt-6">
              <div className="space-y-2">
            {/* 1. Koppla bank */}
            {hasBankingExtension && (
              <div
                role="button"
                tabIndex={isSandbox ? -1 : 0}
                aria-disabled={isSandbox}
                className={cn(
                  'group flex items-start gap-4 rounded-lg border bg-card p-5 transition-colors',
                  isSandbox
                    ? 'opacity-50 cursor-not-allowed'
                    : 'cursor-pointer hover:border-foreground/15'
                )}
                onClick={() => { if (!isSandbox) setMode('psd2') }}
                onKeyDown={(e) => { if (!isSandbox && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setMode('psd2') } }}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
                  <Landmark className="h-[18px] w-[18px] text-foreground/60" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2.5">
                    <h3 className="text-[15px] font-semibold leading-tight">{t('psd2_title')}</h3>
                    <span className="text-[11px] font-medium text-success bg-success/10 px-2 py-0.5 rounded-full leading-none">
                      {t('psd2_recommended')}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed max-w-lg">
                    {t('psd2_description')}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-2.5 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
              </div>
            )}

            {/* 2. Hämta från annat system */}
            {hasMigrationExtension === true && (
              <div
                role="button"
                tabIndex={isSandbox ? -1 : 0}
                aria-disabled={isSandbox}
                className={cn(
                  'group rounded-lg border bg-card p-5 transition-colors',
                  isSandbox
                    ? 'opacity-50 cursor-not-allowed'
                    : 'cursor-pointer hover:border-foreground/15'
                )}
                onClick={() => { if (!isSandbox) setMode('migration') }}
                onKeyDown={(e) => { if (!isSandbox && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setMode('migration') } }}
              >
                <div className="flex items-start gap-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
                    <ArrowRightLeft className="h-[18px] w-[18px] text-foreground/60" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-[15px] font-semibold leading-tight">{t('migration_title')}</h3>
                    <p className="text-sm mt-1.5 leading-relaxed max-w-lg underline decoration-foreground/20 underline-offset-2 text-muted-foreground">
                      {t('migration_description')}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-2.5 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
                </div>
                <div className="flex flex-wrap gap-2 mt-3.5 ml-[52px]">
                  {([
                    { name: 'Fortnox', logo: '/logos/fortnox.svg' },
                    { name: 'Visma', logo: '/logos/visma.jpeg' },
                    { name: 'Bokio', logo: '/logos/bokio.png' },
                    { name: 'Björn Lundén', logo: '/logos/bjornlunden.png' },
                    { name: 'Briox', logo: '/logos/Briox_logo.png' },
                  ] as const).map(provider => (
                    <div key={provider.name} className="flex items-center gap-1.5 rounded border border-border/60 bg-muted/30 px-2 py-1">
                      <img src={provider.logo} alt={provider.name} className="h-4 w-4 shrink-0 rounded-sm object-contain" />
                      <span className="text-[11px] font-medium text-muted-foreground">{provider.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 3. Banktransaktioner — manual file imports (bank file, CSV/Excel,
                SIE) run entirely on uploaded data with no external service, so
                they stay available in the sandbox, unlike the API-backed options
                above (bank connection, provider migration) which need live
                credentials. */}
            <div
              role="button"
              tabIndex={0}
              className={cn(
                'group flex items-start gap-4 rounded-lg border bg-card p-5 transition-colors',
                'cursor-pointer hover:border-foreground/15'
              )}
              onClick={() => setMode('bank')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMode('bank') } }}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
                <ArrowLeftRight className="h-[18px] w-[18px] text-foreground/60" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[15px] font-semibold leading-tight">{t('bankfile_title')}</h3>
                <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed max-w-lg">
                  {t('bankfile_description')}
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {['CSV', 'OFX', 'SEB', 'Swedbank', 'Nordea'].map(fmt => (
                    <span key={fmt} className="text-[11px] text-muted-foreground/80 bg-muted/80 px-1.5 py-0.5 rounded leading-none">
                      {fmt}
                    </span>
                  ))}
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-2.5 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
            </div>

            {/* 4. CSV/Excel-data (ingående balanser, kunder, leverantörer) */}
            <div
              role="button"
              tabIndex={0}
              className={cn(
                'group flex items-start gap-4 rounded-lg border bg-card p-5 transition-colors',
                'cursor-pointer hover:border-foreground/15'
              )}
              onClick={() => setMode('csv_data')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMode('csv_data') } }}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
                <FileSpreadsheet className="h-[18px] w-[18px] text-foreground/60" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[15px] font-semibold leading-tight">{t('csv_data_title')}</h3>
                <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed max-w-lg">
                  {t('csv_data_description')}
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {[
                    { key: 'XLSX', label: 'XLSX' },
                    { key: 'CSV', label: 'CSV' },
                    { key: 'opening_balances', label: t('csv_chip_opening_balances') },
                    { key: 'customers', label: t('csv_chip_customers') },
                    { key: 'suppliers', label: t('csv_chip_suppliers') },
                    { key: 'articles', label: t('csv_chip_articles') },
                  ].map(chip => (
                    <span key={chip.key} className="text-[11px] text-muted-foreground/80 bg-muted/80 px-1.5 py-0.5 rounded leading-none">
                      {chip.label}
                    </span>
                  ))}
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-2.5 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
            </div>

            {/* 5. Bokföringsdata (SIE) */}
            <div
              role="button"
              tabIndex={0}
              className={cn(
                'group flex items-start gap-4 rounded-lg border bg-card p-5 transition-colors',
                'cursor-pointer hover:border-foreground/15'
              )}
              onClick={() => setMode('sie')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMode('sie') } }}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
                <FileText className="h-[18px] w-[18px] text-foreground/60" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[15px] font-semibold leading-tight">{t('sie_title')}</h3>
                <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed max-w-lg">
                  {t('sie_description')}
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {['SIE4', '.se'].map(fmt => (
                    <span key={fmt} className="text-[11px] text-muted-foreground/80 bg-muted/80 px-1.5 py-0.5 rounded leading-none">
                      {fmt}
                    </span>
                  ))}
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-2.5 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
            </div>
              </div>
            </TabsContent>

            <TabsContent value="export" className="mt-6">
              <div className="space-y-4">
                {/* SIE-export */}
                <div id="sie-export" className="scroll-mt-24 rounded-lg border border-border bg-card p-6">
                  <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
                    {/* Identity */}
                    <div className="flex items-start gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
                        <FileSpreadsheet className="h-[18px] w-[18px] text-foreground/60" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="text-[15px] font-semibold leading-tight">{t('export_sie_title')}</h3>
                        <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                          {t('export_sie_description')}
                        </p>
                      </div>
                    </div>

                    {/* Controls */}
                    <div className="space-y-4">
                      <FiscalYearSelector
                        value={exportPeriodId}
                        onChange={setExportPeriodId}
                        includeAllOption={false}
                        hideFuturePeriods
                        label={t('export_sie_period_label')}
                      />
                      <label className="flex items-start gap-2 text-sm text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 rounded border-border"
                          checked={exportExcludeClosing}
                          onChange={(e) => setExportExcludeClosing(e.target.checked)}
                        />
                        <span>{t('export_sie_exclude_closing_label')}</span>
                      </label>
                      <Button
                        onClick={() => {
                          if (exportPeriodId) {
                            const params = new URLSearchParams({ period_id: exportPeriodId })
                            if (exportExcludeClosing) params.set('exclude_closing', 'true')
                            window.open(`/api/reports/sie-export?${params.toString()}`, '_blank')
                          }
                        }}
                        disabled={!exportPeriodId}
                        className="w-full sm:w-auto"
                      >
                        <Download className="mr-2 h-4 w-4" />
                        {t('export_sie_button')}
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Molnsynkronisering (Google Drive) */}
                {hasCloudBackup && (
                  <div id="cloud-backup" className="scroll-mt-24">
                    <CloudBackupCard />
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}

      {mode !== null && (
        <Button variant="ghost" size="sm" onClick={() => setMode(null)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('back_to_choices')}
        </Button>
      )}

      {mode === 'psd2' && <PSD2ConnectWizard />}
      {mode === 'bank' && <BankFileImportWizard />}
      {mode === 'sie' && <SIEImportWizard />}
      {mode === 'csv_data' && <CSVDataImportWizard />}
      {mode === 'migration' && <MigrationWizard userId={userId} />}
    </div>
  )
}
