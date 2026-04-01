'use client'

import { useState, useCallback, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { ArrowLeftRight, ArrowRightLeft, FileText, ArrowLeft, Landmark, Loader2, Info, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
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

// SIE import components
import SIEUploadStep from '@/components/import/SIEUploadStep'
import SIEPreviewStep from '@/components/import/SIEPreviewStep'
import AccountMappingStep from '@/components/import/AccountMappingStep'
import ImportReviewStep, { type ImportExecuteOptions } from '@/components/import/ImportReviewStep'
import ImportResultStep from '@/components/import/ImportResultStep'
import { applyMappingOverride } from '@/lib/import/account-mapper'
import { getCSVHeaders, getCSVPreview } from '@/lib/import/bank-file/formats/generic-csv'
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

const MigrationWizard = dynamic(
  () => import('@/components/extensions/general/ArcimMigrationWorkspace'),
  { ssr: false, loading: () => <div className="flex items-center gap-3 text-muted-foreground p-6"><Loader2 className="h-5 w-5 animate-spin" />Laddar migreringsverktyg...</div> }
)

// ============================================================
// Bank File Import Wizard Steps
// ============================================================

type BankFileStep = 'upload' | 'preview' | 'column_mapping' | 'confirm' | 'result'

const BANK_STEPS: BankFileStep[] = ['upload', 'preview', 'confirm', 'result']
const BANK_STEPS_WITH_MAPPING: BankFileStep[] = ['upload', 'preview', 'column_mapping', 'confirm', 'result']

const BANK_STEP_LABELS: Record<BankFileStep, string> = {
  upload: 'Ladda upp',
  preview: 'Förhandsgranskning',
  column_mapping: 'Kolumnmappning',
  confirm: 'Bekräfta',
  result: 'Resultat',
}

function BankFileImportWizard() {
  const { toast } = useToast()

  const [bankStep, setBankStep] = useState<BankFileStep>('upload')
  const [bankIsLoading, setBankIsLoading] = useState(false)
  const [bankError, setBankError] = useState<string | null>(null)

  // Parse results
  const [parseResult, setParseResult] = useState<BankFileParseResult | null>(null)
  const [detectedFormat, setDetectedFormat] = useState<string | null>(null)
  const [detectedFormatName, setDetectedFormatName] = useState<string | null>(null)
  const [fileHash, setFileHash] = useState<string>('')
  const [filename, setFilename] = useState<string>('')
  const [rawFileContent, setRawFileContent] = useState<string>('')

  // Column mapping for generic CSV
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [csvPreview, setCsvPreview] = useState<string[][]>([])

  // Import result
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null)

  const steps = parseResult?.format === 'generic_csv' ? BANK_STEPS_WITH_MAPPING : BANK_STEPS
  const currentStepIndex = steps.indexOf(bankStep)
  const progress = ((currentStepIndex + 1) / steps.length) * 100

  const handleFileSelect = useCallback(async (file: File, formatOverride?: BankFileFormatId) => {
    setBankError(null)
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
        if (data.error === 'duplicate') {
          setBankError(data.message)
        } else {
          setBankError(data.error || 'Kunde inte läsa filen')
        }
        return
      }

      setParseResult(data.data.parse_result)
      setDetectedFormat(data.data.detected_format)
      setDetectedFormatName(data.data.detected_format_name)
      setFileHash(data.data.file_hash)
      setFilename(data.data.filename)
      // Store headers for generic CSV mapping
      if (data.data.headers) {
        setCsvHeaders(data.data.headers)
      }

      // Read raw file content for CSV preview
      const text = await file.text()
      setRawFileContent(text)
      if (data.data.parse_result.format === 'generic_csv') {
        setCsvHeaders(getCSVHeaders(text))
        setCsvPreview(getCSVPreview(text, ',', 6))
      }

      const txCount = data.data.parse_result.transactions.length
      if (txCount > 0) {
        setBankStep('preview')
        toast({
          title: 'Fil analyserad',
          description: `${txCount} transaktioner hittades`,
        })
      } else if (data.data.parse_result.format === 'generic_csv' || !data.data.detected_format) {
        setBankError('Kunde inte identifiera bankformatet. Välj bank manuellt eller använd "Annan CSV".')
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

  const handleExecuteImport = useCallback(async (options: { skip_duplicates: boolean; auto_categorize: boolean }) => {
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
    setCsvHeaders([])
    setCsvPreview([])
    setRawFileContent('')
  }

  return (
    <div className="space-y-6">
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
          headers={csvHeaders}
          previewRows={csvPreview}
          onConfirm={handleColumnMappingConfirm}
          onBack={() => setBankStep('preview')}
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
        if (data.error === 'duplicate' || data.error === 'duplicate_period') {
          setError(data.message)
        } else if (data.error === 'validation') {
          setError(`${data.message}: ${data.errors?.join(', ') || 'Unknown validation error'}`)
        } else {
          setError(data.error || 'Failed to parse file')
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
      setError(err instanceof Error ? err.message : 'Failed to parse file')
    } finally {
      setIsLoading(false)
    }
  }, [toast])

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
        toast({ title: 'Kunde inte skapa konton', description: data.error || 'Försök igen.', variant: 'destructive' })
        return
      }

      toast({ title: 'Konton skapade', description: `${data.created} nya konton har lagts till i din kontoplan` })

      if (file) {
        const formData = new FormData()
        formData.append('file', file)

        const parseRes = await fetch('/api/import/sie/parse', { method: 'POST', body: formData })
        const parseData = await parseRes.json()

        if (parseRes.ok) {
          setMappings(parseData.mappings)
          setPreview(parseData.preview)

          const accountsRes = await fetch('/api/bookkeeping/accounts')
          if (accountsRes.ok) {
            const accountsData = await accountsRes.json()
            setBasAccounts(accountsData.data || [])
          }
        }
      }
    } catch (err) {
      toast({ title: 'Kunde inte skapa konton', description: err instanceof Error ? err.message : 'Försök igen.', variant: 'destructive' })
    } finally {
      setIsCreatingAccounts(false)
    }
  }, [missingAccounts, file, toast])

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
        if (data.result) { setImportResult(data.result) } else { setError(data.error || 'Import failed'); return }
      } else {
        setImportResult(data.result)
      }

      setStep('result')

      if (data.result?.success) {
        toast({ title: 'Import genomförd', description: `${data.result.journalEntriesCreated} verifikationer skapades` })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setIsLoading(false)
    }
  }, [file, mappings, toast])

  const goToStep = (targetStep: ImportWizardStep) => { setStep(targetStep); setError(null) }
  const goBack = () => { const i = sieSteps.indexOf(step); if (i > 0) setStep(sieSteps[i - 1]) }

  const handleNewImport = () => {
    setStep('upload'); setFile(null); setParsed(null); setMappings([])
    setPreview(null); setIssues([]); setImportResult(null); setError(null)
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

      {step === 'upload' && <SIEUploadStep onFileSelect={handleFileSelect} isLoading={isLoading} error={error} />}
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
      {step === 'result' && importResult && <ImportResultStep result={importResult} onNewImport={handleNewImport} />}
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

type ImportMode = null | 'psd2' | 'bank' | 'sie' | 'migration'

export default function ImportPage() {
  const { company } = useCompany()
  const [mode, setMode] = useState<ImportMode>(null)
  const [userId, setUserId] = useState('')
  const [isSandbox, setIsSandbox] = useState(false)

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

  // Auto-detect OAuth callback or deep-link mode from query params (disabled in sandbox)
  useEffect(() => {
    if (isSandbox) return
    const params = new URLSearchParams(window.location.search)
    if (params.get('migration')) {
      setMode('migration')
    } else {
      const modeParam = params.get('mode')
      if (modeParam && ['psd2', 'bank', 'sie', 'migration'].includes(modeParam)) {
        setMode(modeParam as ImportMode)
      }
    }
  }, [isSandbox])
  // Extensions are active if compiled in — no runtime toggle check needed
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')
  const hasMigrationExtension = ENABLED_EXTENSION_IDS.has('arcim-migration')

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">Importera</h1>
        <p className="text-muted-foreground">
          Importera banktransaktioner eller bokföringsdata till ditt företag
        </p>
      </div>

      {mode === null && (
        <>
          {isSandbox && (
            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3">
              <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-sm text-muted-foreground">
                Import är inte tillgängligt i sandlådemiljön. Skapa ett konto för att importera data.
              </p>
            </div>
          )}

          <div className="space-y-2">
            {/* 1. Koppla bank */}
            {hasBankingExtension && (
              <div
                role="button"
                tabIndex={isSandbox ? -1 : 0}
                aria-disabled={isSandbox}
                className={cn(
                  'group flex items-start gap-4 rounded-lg border bg-card p-5 transition-all',
                  isSandbox
                    ? 'opacity-50 cursor-not-allowed'
                    : 'cursor-pointer hover:border-foreground/15 hover:shadow-[var(--shadow-sm)] active:scale-[0.998]'
                )}
                onClick={() => { if (!isSandbox) setMode('psd2') }}
                onKeyDown={(e) => { if (!isSandbox && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setMode('psd2') } }}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
                  <Landmark className="h-[18px] w-[18px] text-foreground/60" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2.5">
                    <h3 className="text-[15px] font-semibold leading-tight">Koppla bank</h3>
                    <span className="text-[11px] font-medium text-success bg-success/10 px-2 py-0.5 rounded-full leading-none">
                      Rekommenderat
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed max-w-lg">
                    Anslut ditt bankkonto direkt och synka transaktioner automatiskt via PSD2.
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
                  'group rounded-lg border bg-card p-5 transition-all',
                  isSandbox
                    ? 'opacity-50 cursor-not-allowed'
                    : 'cursor-pointer hover:border-foreground/15 hover:shadow-[var(--shadow-sm)] active:scale-[0.998]'
                )}
                onClick={() => { if (!isSandbox) setMode('migration') }}
                onKeyDown={(e) => { if (!isSandbox && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setMode('migration') } }}
              >
                <div className="flex items-start gap-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
                    <ArrowRightLeft className="h-[18px] w-[18px] text-foreground/60" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-[15px] font-semibold leading-tight">Hämta från annat system</h3>
                    <p className="text-sm mt-1.5 leading-relaxed max-w-lg underline decoration-foreground/20 underline-offset-2 text-muted-foreground">
                      Inget ändras i ditt befintliga system.
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

            {/* 3. Banktransaktioner */}
            <div
              role="button"
              tabIndex={isSandbox ? -1 : 0}
              aria-disabled={isSandbox}
              className={cn(
                'group flex items-start gap-4 rounded-lg border bg-card p-5 transition-all',
                isSandbox
                  ? 'opacity-50 cursor-not-allowed'
                  : 'cursor-pointer hover:border-foreground/15 hover:shadow-[var(--shadow-sm)] active:scale-[0.998]'
              )}
              onClick={() => { if (!isSandbox) setMode('bank') }}
              onKeyDown={(e) => { if (!isSandbox && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setMode('bank') } }}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
                <ArrowLeftRight className="h-[18px] w-[18px] text-foreground/60" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[15px] font-semibold leading-tight">Banktransaktioner</h3>
                <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed max-w-lg">
                  Importera kontoutdrag från din bank. Stöder de flesta svenska banker.
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

            {/* 4. Bokföringsdata (SIE) */}
            <div
              role="button"
              tabIndex={isSandbox ? -1 : 0}
              aria-disabled={isSandbox}
              className={cn(
                'group flex items-start gap-4 rounded-lg border bg-card p-5 transition-all',
                isSandbox
                  ? 'opacity-50 cursor-not-allowed'
                  : 'cursor-pointer hover:border-foreground/15 hover:shadow-[var(--shadow-sm)] active:scale-[0.998]'
              )}
              onClick={() => { if (!isSandbox) setMode('sie') }}
              onKeyDown={(e) => { if (!isSandbox && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setMode('sie') } }}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
                <FileText className="h-[18px] w-[18px] text-foreground/60" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[15px] font-semibold leading-tight">Bokföringsdata (SIE)</h3>
                <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed max-w-lg">
                  Importera verifikationer och kontoplan från ett annat bokföringsprogram.
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {['SIE4', '.se', '.si'].map(fmt => (
                    <span key={fmt} className="text-[11px] text-muted-foreground/80 bg-muted/80 px-1.5 py-0.5 rounded leading-none">
                      {fmt}
                    </span>
                  ))}
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-2.5 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
            </div>
          </div>
        </>
      )}

      {mode !== null && (
        <Button variant="ghost" size="sm" onClick={() => setMode(null)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Tillbaka till val
        </Button>
      )}

      {mode === 'psd2' && <PSD2ConnectWizard />}
      {mode === 'bank' && <BankFileImportWizard />}
      {mode === 'sie' && <SIEImportWizard />}
      {mode === 'migration' && <MigrationWizard userId={userId} />}
    </div>
  )
}
