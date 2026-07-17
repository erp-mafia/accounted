'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, ShieldCheck, Download, Upload, Link2, CloudUpload } from 'lucide-react'
import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import type { CompanyObxModuleRow, CompanyObxIndexRow } from '@/lib/obx/company-archive'
import type { ObxApprovalMethod } from '@/lib/obx/export-approval'
import type { FiscalPeriod } from '@/types'
import { cn } from '@/lib/utils'

interface ArchiveState {
  modules: CompanyObxModuleRow[]
  index: CompanyObxIndexRow | null
}

const bankIdAvailable =
  process.env.NEXT_PUBLIC_BANKID_ENABLED === 'true' &&
  process.env.NEXT_PUBLIC_SELF_HOSTED !== 'true'

export function ObxArchivePanel() {
  const { toast } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<ArchiveState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [exportPeriodId, setExportPeriodId] = useState<string | null>(null)
  const [exportPeriod, setExportPeriod] = useState<FiscalPeriod | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [approvalMethod, setApprovalMethod] = useState<ObxApprovalMethod>(
    bankIdAvailable ? 'bankid' : 'passphrase',
  )
  const [hybridPublish, setHybridPublish] = useState(false)
  const [checklistSummary, setChecklistSummary] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/bookkeeping/obx')
      if (!res.ok) throw new Error('fetch failed')
      const json = await res.json()
      setState(json.data as ArchiveState)
    } catch {
      setState({ modules: [], index: null })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void (async () => {
      try {
        const year = new Date().getFullYear()
        const res = await fetch(`/api/bookkeeping/obx/publish?fiscal_year=${year}`)
        if (!res.ok) return
        const json = await res.json()
        const mode = json.data?.ledger_mode as string | undefined
        const configured = Boolean(json.data?.publish_configured)
        setHybridPublish(mode === 'hybrid' && configured)
      } catch {
        setHybridPublish(false)
      }
    })()
  }, [])

  async function downloadBlob(res: Response, fallbackName: string) {
    const blob = await res.blob()
    const disposition = res.headers.get('Content-Disposition')
    const match = disposition?.match(/filename="([^"]+)"/)
    const name = match?.[1] ?? fallbackName
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  async function exportYearSeal() {
    if (!exportPeriodId || !exportPeriod) {
      toast({
        title: 'Välj räkenskapsår',
        description: 'Skapa ett räkenskapsår ovan om listan är tom.',
        variant: 'destructive',
      })
      return
    }

    if (approvalMethod === 'passphrase' && passphrase.trim().length < 4) {
      toast({
        title: 'Ange en kod',
        description: 'Minst 4 tecken krävs för att försegla exporten.',
        variant: 'destructive',
      })
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/bookkeeping/obx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'year',
          fiscal_period_id: exportPeriodId,
          fiscal_year: Number.parseInt(exportPeriod.period_start.slice(0, 4), 10),
          include_documents: true,
          approval_method: approvalMethod,
          passphrase: approvalMethod === 'passphrase' ? passphrase : undefined,
        }),
      })
      if (!res.ok) {
        const message = await getResponseErrorMessage(res, 'settings')
        throw new Error(message)
      }
      const exportLabel = exportPeriod.period_start.slice(0, 4)
      await downloadBlob(res, `obx_${exportLabel}.obx`)
      toast({
        title: 'Årsmodul exporterad',
        description:
          approvalMethod === 'bankid'
            ? 'Försegling med BankID loggad i filen.'
            : 'Försegling med kod loggad i filen.',
      })
      await load()
    } catch (err) {
      toast({
        title: 'Export misslyckades',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  async function exportIndex() {
    setBusy(true)
    try {
      const res = await fetch('/api/bookkeeping/obx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'index' }),
      })
      if (!res.ok) {
        const message = await getResponseErrorMessage(res, 'settings')
        throw new Error(message)
      }
      await downloadBlob(res, 'obx_index.obx')
      toast({ title: 'Index exporterat' })
      await load()
    } catch (err) {
      toast({
        title: 'Indexexport misslyckades',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  async function verifyChain() {
    setBusy(true)
    try {
      const res = await fetch('/api/bookkeeping/obx?action=verify')
      const json = await res.json()
      const data = json.data as { ok: boolean; issues: { message: string }[] }
      if (data.ok) {
        toast({ title: 'Kedjan verifierad', description: 'Alla moduler stämmer.' })
      } else {
        toast({
          title: 'Kedjeproblem',
          description: data.issues.map((i) => i.message).join('; '),
          variant: 'destructive',
        })
      }
    } catch {
      toast({ title: 'Verifiering misslyckades', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  async function runChecklistAndPublish() {
    if (!exportPeriod) {
      toast({
        title: 'Välj räkenskapsår',
        description: 'Publicering kräver ett valt räkenskapsår.',
        variant: 'destructive',
      })
      return
    }
    const fiscalYear = Number.parseInt(exportPeriod.period_start.slice(0, 4), 10)
    if (approvalMethod === 'passphrase' && passphrase.trim().length < 4) {
      toast({
        title: 'Ange en kod',
        description: 'Minst 4 tecken krävs för att försegla innan publicering.',
        variant: 'destructive',
      })
      return
    }

    setBusy(true)
    setChecklistSummary(null)
    try {
      const checkRes = await fetch(`/api/bookkeeping/obx/publish?fiscal_year=${fiscalYear}`)
      const checkJson = await checkRes.json()
      const items = (checkJson.data?.items ?? []) as { message: string; ok: boolean; severity: string }[]
      setChecklistSummary(
        items.map((i) => `${i.ok ? '✓' : '✗'} ${i.message}`).join('\n'),
      )
      if (!checkJson.data?.can_publish) {
        toast({
          title: 'Checklistan blockerar',
          description: 'Åtgärda blockerade punkter innan publicering till Ombra.',
          variant: 'destructive',
        })
        return
      }

      const res = await fetch('/api/bookkeeping/obx/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiscal_year: fiscalYear,
          approval_method: approvalMethod,
          passphrase: approvalMethod === 'passphrase' ? passphrase : undefined,
          include_documents: true,
        }),
      })
      if (!res.ok) {
        const message = await getResponseErrorMessage(res, 'settings')
        throw new Error(message)
      }
      toast({
        title: 'Publicerat till Ombra',
        description: `År ${fiscalYear} skickades som förseglad year-seal till hosted huvudbok.`,
      })
      await load()
    } catch (err) {
      toast({
        title: 'Publicering misslyckades',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  async function importModule(file: File) {
    setBusy(true)
    try {
      const form = new FormData()
      form.set('file', file)
      if (passphrase) form.set('passphrase', passphrase)
      form.set('module_type', file.name.includes('index') ? 'index' : 'year')

      const res = await fetch('/api/bookkeeping/obx/import', { method: 'POST', body: form })
      if (!res.ok) {
        const message = await getResponseErrorMessage(res, 'settings')
        throw new Error(message)
      }
      toast({ title: 'OBX-modul importerad' })
      await load()
    } catch (err) {
      toast({
        title: 'Import misslyckades',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (loading) {
    return <Skeleton className="h-32 w-full" />
  }

  const modules = state?.modules ?? []
  const index = state?.index

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Bokföringsarkiv (OBX)</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Modulära årsförseglingar med index och kedjeverifiering. Godkännande (BankID eller kod)
          loggas i <span className="font-mono text-xs">seal.json</span> och{' '}
          <span className="font-mono text-xs">signatures/export-approval.json</span>.
        </p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Godkänn export med</span>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={approvalMethod === 'passphrase' ? 'default' : 'outline'}
              className={cn(approvalMethod === 'passphrase' && 'ring-1 ring-primary')}
              onClick={() => setApprovalMethod('passphrase')}
              disabled={busy}
            >
              Kod
            </Button>
            <Button
              type="button"
              size="sm"
              variant={approvalMethod === 'bankid' ? 'default' : 'outline'}
              className={cn(approvalMethod === 'bankid' && 'ring-1 ring-primary')}
              onClick={() => bankIdAvailable && setApprovalMethod('bankid')}
              disabled={busy || !bankIdAvailable}
              title={bankIdAvailable ? undefined : 'BankID är inte aktiverat i denna miljö'}
            >
              BankID
            </Button>
          </div>
          {!bankIdAvailable ? (
            <p className="text-xs text-muted-foreground">
              BankID är avstängt under utveckling — använd kod tills vidare.
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 items-end">
          <FiscalYearSelector
            value={exportPeriodId}
            onChange={(periodId, period) => {
              setExportPeriodId(periodId)
              setExportPeriod(period ?? null)
            }}
            includeAllOption={false}
            label="Räkenskapsår"
            className="space-y-1"
          />
          {approvalMethod === 'passphrase' ? (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="obx-pass">
                Förseglingskod
              </label>
              <Input
                id="obx-pass"
                type="password"
                className="w-40"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Minst 4 tecken"
                autoComplete="off"
              />
            </div>
          ) : null}
          <Button
            size="sm"
            onClick={() => void exportYearSeal()}
            disabled={busy || !exportPeriodId}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            <span className="ml-2">Exportera år</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => void exportIndex()} disabled={busy}>
            <Link2 className="h-4 w-4" />
            <span className="ml-2">Exportera index</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => void verifyChain()} disabled={busy}>
            <ShieldCheck className="h-4 w-4" />
            <span className="ml-2">Verifiera kedja</span>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            <Upload className="h-4 w-4" />
            <span className="ml-2">Importera modul</span>
          </Button>
          {hybridPublish ? (
            <Button
              size="sm"
              variant="default"
              onClick={() => void runChecklistAndPublish()}
              disabled={busy || !exportPeriodId}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CloudUpload className="h-4 w-4" />
              )}
              <span className="ml-2">Publicera år till Ombra</span>
            </Button>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept=".obx,application/zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importModule(f)
            }}
          />
        </div>
        {hybridPublish ? (
          <p className="text-xs text-muted-foreground">
            Hybrid-läge: lokal verkstad publicerar förseglad year-seal till hosted huvudbok efter
            checklista (utkast, BFL-timing, kedja). Lokalt arbete ≠ bokfört hos Ombra förrän
            publicering lyckas.
          </p>
        ) : null}
        {checklistSummary ? (
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap rounded-md border p-2">
            {checklistSummary}
          </pre>
        ) : null}
      </div>

      {index ? (
        <p className="text-xs text-muted-foreground font-mono truncate">
          chain_root: {index.chain_root}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {modules.length === 0 ? (
          <span className="text-sm text-muted-foreground">Inga moduler registrerade ännu.</span>
        ) : (
          modules.map((m) => (
            <Badge
              key={m.id}
              variant={m.sealed ? 'default' : 'secondary'}
              className="font-mono text-xs"
            >
              {m.fiscal_year}
              {m.sealed ? ' 🔒' : ''}
              {m.origin_system ? ` · ${m.origin_system}` : ''}
            </Badge>
          ))
        )}
      </div>
    </div>
  )
}
