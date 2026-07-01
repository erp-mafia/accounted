'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { AlertTriangle, FileDown, Info } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import type { EgenavgiftCategory } from '@/lib/bokslut/enskild-firma/egenavgifter-calculator'
import type { EfDeclarationItem } from '@/lib/bokslut/enskild-firma/types'

interface EfDeclarationSectionProps {
  fiscalPeriodId: string
  /** Bokfört resultat (income statement net_result) — shown as the surplus
   *  base in the wizard header. Server recomputes from the trial balance. */
  bookedSurplus: number
  /** Closing year of the fiscal period (for periodiseringsfond cohort). */
  fiscalYear: number
}

interface EfOverrideInputs {
  category: EgenavgiftCategory
  kapitalunderlag: string
  priorSchablon: string
  priorActual: string
  pfondDesired: string
  expansionsfondBalance: string
  expansionsfondChange: string
}

interface EfPreviewResponse {
  fiscalPeriod: {
    id: string
    name: string
    period_start: string
    period_end: string
  }
  bookedSurplus: number
  items: EfDeclarationItem[]
  postedEntryCount: number
  inputWarnings: string[]
}

const DEFAULT_OVERRIDES: EfOverrideInputs = {
  category: 'full',
  kapitalunderlag: '',
  priorSchablon: '',
  priorActual: '',
  pfondDesired: '',
  expansionsfondBalance: '',
  expansionsfondChange: '',
}

/**
 * EF declaration step — fetches the four calculator outputs (egenavgifter,
 * räntefördelning, periodiseringsfond-EF, expansionsfond) from the server
 * so the same source-of-truth (computeEfDeclarationPreview) is used by
 * wizard, MCP tool and NE-bilaga.
 *
 * EF tax mechanisms are declaration-only — they NEVER produce journal
 * entries. The banner makes that BFL distinction visible.
 *
 * Override inputs persist to localStorage scoped by fiscal period id, so
 * re-entering the wizard recalls them without round-tripping a write.
 */
export function EfDeclarationSection({
  fiscalPeriodId,
  bookedSurplus,
  fiscalYear,
}: EfDeclarationSectionProps) {
  const storageKey = `ef-declaration-overrides:${fiscalPeriodId}`

  const [overrides, setOverrides] = useState<EfOverrideInputs>(DEFAULT_OVERRIDES)
  const [preview, setPreview] = useState<EfPreviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Restore overrides from localStorage on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<EfOverrideInputs>
        setOverrides({ ...DEFAULT_OVERRIDES, ...parsed })
      }
    } catch {
      // Ignore — start with defaults.
    }
  }, [storageKey])

  // Persist overrides on change.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(overrides))
    } catch {
      // Quota exceeded or disabled — non-fatal.
    }
  }, [storageKey, overrides])

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set('category', overrides.category)
    const kap = parseFloat(overrides.kapitalunderlag)
    if (Number.isFinite(kap)) params.set('kapitalunderlag', String(kap))
    const ps = parseFloat(overrides.priorSchablon)
    if (Number.isFinite(ps)) params.set('priorYearSchablonavdrag', String(ps))
    const pa = parseFloat(overrides.priorActual)
    if (Number.isFinite(pa)) params.set('priorYearActualCharged', String(pa))
    const pf = parseFloat(overrides.pfondDesired)
    if (Number.isFinite(pf)) params.set('pfondDesiredAmount', String(pf))
    const eb = parseFloat(overrides.expansionsfondBalance)
    if (Number.isFinite(eb)) params.set('expansionsfondExistingBalance', String(eb))
    const ec = parseFloat(overrides.expansionsfondChange)
    if (Number.isFinite(ec) && ec !== 0) params.set('expansionsfondDesiredChange', String(ec))
    return params.toString()
  }, [overrides])

  const loadPreview = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${fiscalPeriodId}/ef-declaration?${queryString}`,
      )
      const body = await res.json()
      if (!res.ok) {
        setError(body?.error?.message ?? 'Kunde inte ladda EF-deklaration')
        setPreview(null)
        return
      }
      setPreview(body.data as EfPreviewResponse)
    } catch {
      setError('Kunde inte ladda EF-deklaration')
      setPreview(null)
    } finally {
      setLoading(false)
    }
  }, [fiscalPeriodId, queryString])

  // Debounce refetch so each keystroke doesn't slam the API. 350 ms feels
  // responsive without being noisy.
  useEffect(() => {
    const handle = setTimeout(() => {
      void loadPreview()
    }, 350)
    return () => clearTimeout(handle)
  }, [loadPreview])

  const update = useCallback(
    <K extends keyof EfOverrideInputs>(field: K, value: EfOverrideInputs[K]) => {
      setOverrides((prev) => ({ ...prev, [field]: value }))
    },
    [],
  )

  const items = preview?.items ?? []
  const inputWarnings = preview?.inputWarnings ?? []
  const noPostedEntries = preview ? preview.postedEntryCount === 0 : false

  return (
    <div className="space-y-6">
      {/* BFL distinction banner — EF values are declaration-only, never booked. */}
      <Card className="border-border bg-secondary/40">
        <CardContent className="p-4 flex items-start gap-3">
          <Info className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              Skattemässiga justeringar — NE-bilaga
            </span>
            <br />
            För enskild firma bokförs varken skatt, egenavgifter, fonder eller räntefördelning.
            Värdena nedan visar vad du fyller i på NE-bilagan när du deklarerar. Inga verifikat skapas.
          </p>
        </CardContent>
      </Card>

      {/* "No journal entries posted" banner — surfaced when the period has
          zero posted vouchers, so the user knows the surplus is 0 because
          nothing's booked yet, not because the calculators failed. */}
      {noPostedEntries && (
        <Card className="border-border">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-warning-foreground shrink-0" />
            <p className="text-sm">
              <span className="font-medium">Inga verifikat bokförda i perioden.</span>{' '}
              Värdena nedan baseras enbart på NE-bilagans räkenskapsschema (intäkter och
              kostnader hittills). Bokför löpande verifikat först för att få ett realistiskt
              överskott.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Input form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Indata</CardTitle>
          <p className="text-sm text-muted-foreground">
            Bokfört överskott:{' '}
            <span className="tabular-nums font-medium text-foreground">
              {formatCurrency(preview?.bookedSurplus ?? bookedSurplus)}
            </span>
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Egenavgifter — kategori</Label>
              <select
                className="border border-border rounded-md h-9 text-sm px-2 w-full bg-background"
                value={overrides.category}
                onChange={(e) => update('category', e.target.value as EgenavgiftCategory)}
              >
                <option value="full">Aktiv, full sats (28,97 %)</option>
                <option value="pensioner">Pensionär (10,21 %)</option>
                <option value="passive">Passiv (SLP 24,26 %)</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Kapitalunderlag (vid IB)</Label>
              <Input
                type="number"
                step="1"
                value={overrides.kapitalunderlag}
                onChange={(e) => update('kapitalunderlag', e.target.value)}
                placeholder="0"
                className="tabular-nums h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Föregående års schablonavdrag (R40)</Label>
              <Input
                type="number"
                step="1"
                value={overrides.priorSchablon}
                onChange={(e) => update('priorSchablon', e.target.value)}
                placeholder="0"
                className="tabular-nums h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Föregående års faktiska egenavgifter (R41)</Label>
              <Input
                type="number"
                step="1"
                value={overrides.priorActual}
                onChange={(e) => update('priorActual', e.target.value)}
                placeholder="0"
                className="tabular-nums h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Önskad periodiseringsfond (max 30 %)</Label>
              <Input
                type="number"
                step="1"
                value={overrides.pfondDesired}
                onChange={(e) => update('pfondDesired', e.target.value)}
                placeholder="0"
                className="tabular-nums h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tidigare expansionsfond — saldo</Label>
              <Input
                type="number"
                step="1"
                value={overrides.expansionsfondBalance}
                onChange={(e) => update('expansionsfondBalance', e.target.value)}
                placeholder="0"
                className="tabular-nums h-9"
              />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">
                Ändring av expansionsfond (+ avsättning, − återföring)
              </Label>
              <Input
                type="number"
                step="1"
                value={overrides.expansionsfondChange}
                onChange={(e) => update('expansionsfondChange', e.target.value)}
                placeholder="0"
                className="tabular-nums h-9"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Top-level input warnings (e.g. missing kapitalunderlag) */}
      {inputWarnings.map((w, i) => (
        <Card key={i} className="border-border">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-warning-foreground shrink-0" />
            <p className="text-sm">{w}</p>
          </CardContent>
        </Card>
      ))}

      {/* Loading / error / items */}
      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {loading && !preview && (
        <Card>
          <CardContent className="p-6 space-y-3">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-20 w-full" />
          </CardContent>
        </Card>
      )}

      {items.map((item) => (
        <Card key={item.kind}>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <CardTitle className="text-base">{item.label}</CardTitle>
                <p className="text-sm text-muted-foreground mt-1">{item.description}</p>
                <p className="text-xs text-muted-foreground mt-1">NE-ruta {item.ne_ruta}</p>
              </div>
              <p className="font-display text-2xl tabular-nums shrink-0">
                {formatCurrency(item.amount)}
              </p>
            </div>
          </CardHeader>
          {item.warnings.length > 0 && (
            <CardContent className="text-sm text-warning-foreground space-y-1">
              {item.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </CardContent>
          )}
        </Card>
      ))}

      {/* NE-bilaga download */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Info className="h-4 w-4 text-muted-foreground" />
            NE-bilaga räkenskapsschema (R1–R11)
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Räkenskapsschema-delen genereras automatiskt från bokföringen för räkenskapsåret {fiscalYear}.
            Ladda ner SRU-filen och ladda upp den i Skatteverkets e-tjänst för Inkomstdeklaration 1.
          </p>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link
              href={`/api/reports/ne-bilaga?period_id=${fiscalPeriodId}&format=sru`}
              prefetch={false}
            >
              <FileDown className="mr-2 h-4 w-4" />
              Ladda ner NE-bilaga (SRU)
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
