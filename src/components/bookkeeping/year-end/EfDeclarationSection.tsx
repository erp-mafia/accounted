'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  DocumentArrowDownIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from '@/components/icons'
import { formatCurrency, formatRowAmount } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import { isFiscalYear } from '@/lib/invariants/fiscal-year'
import type { EgenavgiftCategory } from '@/lib/bokslut/enskild-firma/egenavgifter-calculator'
import type { NeDeclarationInputs } from '@/lib/bokslut/enskild-firma/declaration-inputs'
import { EF_NE_BOOKED_ROWS, type EfDeclarationItem, type EfNeRutor, type EfOvrigUppgift } from '@/lib/bokslut/enskild-firma/types'
import type { EfFondState } from '@/lib/bokslut/enskild-firma/periodiseringsfond-ef'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

interface EfDeclarationSectionProps {
  fiscalPeriodId: string
  /** Bokfört resultat (income statement net_result): shown as the surplus
   *  base in the wizard header. Server recomputes from the trial balance. */
  bookedSurplus: number
  /** Closing year of the fiscal period (for periodiseringsfond cohort). */
  fiscalYear: number
}

interface EfOverrideInputs {
  category: EgenavgiftCategory
  kapitalunderlag: string
  sparatFordelningsbelopp: string
  expansionsfondKapitalunderlag: string
  priorSchablon: string
  priorActual: string
  pfondDesired: string
  /** Earlier years' periodiseringsfonder, as typed (year and balance). */
  pfondFonder: Array<{ year: string; balance: string }>
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
  pfondFonder?: EfFondState[]
  rutor?: EfNeRutor
  ovrigaUppgifter?: EfOvrigUppgift[]
  warnings?: string[]
  postedEntryCount: number
  inputWarnings: string[]
}

const DEFAULT_OVERRIDES: EfOverrideInputs = {
  category: 'full',
  kapitalunderlag: '',
  sparatFordelningsbelopp: '',
  expansionsfondKapitalunderlag: '',
  priorSchablon: '',
  priorActual: '',
  pfondDesired: '',
  pfondFonder: [],
  expansionsfondBalance: '',
  expansionsfondChange: '',
}

/**
 * EF declaration step: fetches the four calculator outputs (egenavgifter,
 * räntefördelning, periodiseringsfond-EF, expansionsfond) from the server
 * so the same source-of-truth (computeEfDeclarationPreview) is used by
 * wizard, MCP tool and NE-bilaga.
 *
 * EF tax mechanisms are declaration-only: they NEVER produce journal
 * entries. The banner makes that BFL distinction visible.
 *
 * The inputs are saved per räkenskapsår on the server (ne_declaration_inputs,
 * /ef-declaration/inputs), so they follow the owner to any device and next
 * year's step starts from what this year hands on (R40 from this year's R43,
 * the funds that stay, the expansionsfond). A value an earlier version left
 * in this browser's localStorage is taken over once when nothing is saved.
 */
export function EfDeclarationSection({
  fiscalPeriodId,
  bookedSurplus,
  fiscalYear,
}: EfDeclarationSectionProps) {
  const t = useTranslations('efDeclaration')
  const legacyStorageKey = `ef-declaration-overrides:${fiscalPeriodId}`
  const inputsUrl = `/api/bookkeeping/fiscal-periods/${fiscalPeriodId}/ef-declaration/inputs`

  const [overrides, setOverrides] = useState<EfOverrideInputs>(DEFAULT_OVERRIDES)
  const [preview, setPreview] = useState<EfPreviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Saving starts once the stored inputs are in; `savedJson` is what the
  // server holds, so loading (or a carried proposal) never writes by itself.
  const [inputsLoaded, setInputsLoaded] = useState(false)
  const [carriedFrom, setCarriedFrom] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const savedJson = useRef<string | null>(null)

  // Load the stored inputs for the year.
  useEffect(() => {
    let cancelled = false
    setInputsLoaded(false)
    setCarriedFrom(null)
    void (async () => {
      let next = DEFAULT_OVERRIDES
      let baseline: EfOverrideInputs | null = null
      try {
        const res = await fetch(inputsUrl)
        const body = await res.json()
        if (res.ok) {
          const loaded = body.data as { inputs: NeDeclarationInputs; source: string; carriedFrom?: { name: string } }
          if (loaded.source !== 'none') {
            next = fromInputs(loaded.inputs)
            baseline = loaded.source === 'saved' ? next : DEFAULT_OVERRIDES
            if (loaded.source === 'carried' && !cancelled) setCarriedFrom(loaded.carriedFrom?.name ?? null)
          } else {
            next = legacyOverrides(legacyStorageKey) ?? DEFAULT_OVERRIDES
            baseline = DEFAULT_OVERRIDES
          }
        }
      } catch {
        // Offline or refused: start from defaults, nothing is overwritten.
      }
      if (cancelled) return
      setOverrides(next)
      savedJson.current = baseline ? JSON.stringify(toInputs(baseline)) : null
      setInputsLoaded(baseline !== null)
    })()
    return () => {
      cancelled = true
    }
  }, [inputsUrl, legacyStorageKey])

  // Save what the owner changed, debounced.
  useEffect(() => {
    if (!inputsLoaded) return
    const body = JSON.stringify(toInputs(overrides))
    if (body === savedJson.current) return
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(inputsUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body })
          if (!res.ok) throw new Error(String(res.status))
          savedJson.current = body
          setSaveFailed(false)
          try {
            window.localStorage.removeItem(legacyStorageKey)
          } catch {
            // Storage disabled: nothing to clean up.
          }
        } catch {
          setSaveFailed(true)
        }
      })()
    }, 800)
    return () => clearTimeout(handle)
  }, [overrides, inputsLoaded, inputsUrl, legacyStorageKey])

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set('category', overrides.category)
    const kap = parseFloat(overrides.kapitalunderlag)
    if (Number.isFinite(kap)) params.set('kapitalunderlag', String(kap))
    const sparat = parseFloat(overrides.sparatFordelningsbelopp)
    if (Number.isFinite(sparat) && sparat > 0) params.set('sparatFordelningsbelopp', String(sparat))
    const kapUb = parseFloat(overrides.expansionsfondKapitalunderlag)
    if (Number.isFinite(kapUb)) params.set('expansionsfondKapitalunderlag', String(kapUb))
    const ps = parseFloat(overrides.priorSchablon)
    if (Number.isFinite(ps)) params.set('priorYearSchablonavdrag', String(ps))
    const pa = parseFloat(overrides.priorActual)
    if (Number.isFinite(pa)) params.set('priorYearActualCharged', String(pa))
    const pf = parseFloat(overrides.pfondDesired)
    if (Number.isFinite(pf)) params.set('pfondDesiredAmount', String(pf))
    const fonder = enteredFonder(overrides.pfondFonder)
    if (fonder.length > 0) {
      params.set('pfondExistingFonder', fonder.map((f) => `${f.year}:${f.balance}`).join(','))
    }
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
        setError(getUserErrorMessage(body?.error) ?? 'Kunde inte ladda EF-deklaration')
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

  const updateFond = useCallback((index: number, field: 'year' | 'balance', value: string) => {
    setOverrides((prev) => ({
      ...prev,
      pfondFonder: prev.pfondFonder.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    }))
  }, [])
  const addFond = useCallback(() => {
    setOverrides((prev) => ({ ...prev, pfondFonder: [...prev.pfondFonder, { year: '', balance: '' }] }))
  }, [])
  const removeFond = useCallback((index: number) => {
    setOverrides((prev) => ({ ...prev, pfondFonder: prev.pfondFonder.filter((_, i) => i !== index) }))
  }, [])

  const items = preview?.items ?? []
  const inputWarnings = preview?.inputWarnings ?? []
  const rutor = preview?.rutor
  const ovrigaUppgifter = preview?.ovrigaUppgifter ?? []
  const previewWarnings = preview?.warnings ?? []
  const noPostedEntries = preview ? preview.postedEntryCount === 0 : false

  return (
    <div className="space-y-6">
      {/* BFL distinction banner: EF values are declaration-only, never booked. */}
      <Card>
        <CardContent className="flex items-start gap-3">
          <InformationCircleIcon className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              Skattemässiga justeringar: NE-bilaga
            </span>
            <br />
            För enskild firma bokförs varken skatt, egenavgifter, fonder eller räntefördelning.
            Värdena nedan visar vad du fyller i på NE-bilagan när du deklarerar. Inga verifikat skapas.
          </p>
        </CardContent>
      </Card>

      {/* "No journal entries posted" banner: surfaced when the period has
          zero posted vouchers, so the user knows the surplus is 0 because
          nothing's booked yet, not because the calculators failed. */}
      {noPostedEntries && (
        <Card>
          <CardContent className="flex items-start gap-3">
            <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 text-attn shrink-0" />
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
          {carriedFrom && <p className="text-xs text-muted-foreground">{t('carried_from', { year: carriedFrom })}</p>}
          {saveFailed && <p className="text-xs text-destructive">{t('save_failed')}</p>}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Egenavgifter: kategori</Label>
              <select
                className="rounded-lg h-9 text-sm px-2 w-full bg-control shadow-raised"
                value={overrides.category}
                onChange={(e) => update('category', e.target.value as EgenavgiftCategory)}
              >
                <option value="full">Aktiv, full sats (28,97 %)</option>
                <option value="pensioner">Pensionär (10,21 %)</option>
                <option value="passive">Passiv (SLP 24,26 %)</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                Kapitalunderlag för räntefördelning (vid IB, sparat fördelningsbelopp inräknat)
              </Label>
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
              <Label className="text-xs">Sparat fördelningsbelopp från tidigare år</Label>
              <Input
                type="number"
                step="1"
                min="0"
                value={overrides.sparatFordelningsbelopp}
                onChange={(e) => update('sparatFordelningsbelopp', e.target.value)}
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
              <Label className="text-xs">Tidigare expansionsfond: saldo</Label>
              <Input
                type="number"
                step="1"
                value={overrides.expansionsfondBalance}
                onChange={(e) => update('expansionsfondBalance', e.target.value)}
                placeholder="0"
                className="tabular-nums h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Kapitalunderlag för expansionsfond (vid UB)</Label>
              <Input
                type="number"
                step="1"
                value={overrides.expansionsfondKapitalunderlag}
                onChange={(e) => update('expansionsfondKapitalunderlag', e.target.value)}
                placeholder="0"
                className="tabular-nums h-9"
              />
            </div>
            <div className="space-y-1">
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
          <div className="space-y-2">
            <Label className="text-xs">
              Tidigare periodiseringsfonder (avsättningsår och belopp, från respektive års NE-bilaga R34)
            </Label>
            {overrides.pfondFonder.map((row, index) => (
              <div key={index} className="grid grid-cols-[6rem_1fr_auto] items-center gap-2">
                <Input
                  type="number"
                  step="1"
                  value={row.year}
                  onChange={(e) => updateFond(index, 'year', e.target.value)}
                  placeholder="År"
                  aria-label="Avsättningsår"
                  className="tabular-nums h-9"
                />
                <Input
                  type="number"
                  step="1"
                  value={row.balance}
                  onChange={(e) => updateFond(index, 'balance', e.target.value)}
                  placeholder="Belopp"
                  aria-label="Belopp kvar i fonden"
                  className="tabular-nums h-9"
                />
                <Button type="button" variant="ghost" onClick={() => removeFond(index)}>
                  Ta bort
                </Button>
                <FondStatusLine
                  row={row}
                  rows={overrides.pfondFonder}
                  index={index}
                  states={preview?.pfondFonder ?? []}
                  fiscalYear={fiscalYear}
                />
              </div>
            ))}
            <Button type="button" variant="outline" onClick={addFond}>
              Lägg till fond
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Top-level input warnings (e.g. missing kapitalunderlag) */}
      {inputWarnings.map((w, i) => (
        <Card key={i}>
          <CardContent className="flex items-start gap-3">
            <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 text-attn shrink-0" />
            <p className="text-sm">{w}</p>
          </CardContent>
        </Card>
      ))}

      {/* Loading / error / items */}
      {error && <LoadError title={error} onRetry={() => void loadPreview()} />}

      {loading && !preview && (
        <LateReveal className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-20 w-full" />
        </LateReveal>
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
            <CardContent className="text-sm text-attn space-y-1">
              {item.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </CardContent>
          )}
        </Card>
      ))}

      {/* NE-bilaga sida 2: every ruta the preview fills, in the form's order. */}
      {rutor && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">NE-bilaga sida 2</CardTitle>
            <p className="text-sm text-muted-foreground">
              Beloppen att fylla i, i blankettens ordning. Summarutorna visas alltid, övriga när de inte är 0.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Ruta</TableHead>
                  <TableHead>Uppgift</TableHead>
                  <TableHead className="text-right">Belopp</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {NE_RUTA_ROWS.filter((row) => row.sum || rutor[row.ruta] !== 0).map((row) => (
                  <TableRow key={row.ruta}>
                    <TableCell className="text-sm tabular-nums">{row.ruta}</TableCell>
                    <TableCell className={`text-sm ${row.sum ? 'font-medium' : ''}`}>{row.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatRowAmount(rutor[row.ruta])}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {ovrigaUppgifter.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Övriga uppgifter</TableHead>
                    <TableHead className="text-right">Belopp</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ovrigaUppgifter.map((uppgift) => (
                    <TableRow key={uppgift.faltkod}>
                      <TableCell className="text-sm">{uppgift.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRowAmount(uppgift.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {previewWarnings.map((w, i) => (
              <p key={i} className="text-xs text-muted-foreground">
                {w}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {/* NE-bilaga download */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <InformationCircleIcon className="h-4 w-4 text-muted-foreground" />
            NE-bilaga: balansräkning och räkenskapsschema
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Balansräkningen (B1-B16), räkenskapsschemat (R1-R11) och det bokförda resultatet (R12) kommer från bokföringen för räkenskapsåret {fiscalYear}.
            Importera filen blanketter.sru i Skatteverkets e-tjänst Inkomstdeklaration 1 under Bilagor, Enskild näringsverksamhet (NE), och fyll där i resten av sidan 2 med beloppen ovan.
          </p>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link
              href={`/api/reports/ne-bilaga?period_id=${fiscalPeriodId}&format=sru`}
              prefetch={false}
            >
              <DocumentArrowDownIcon className="mr-2 h-4 w-4" />
              Ladda ner NE-bilaga (SRU)
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

/** NE-bilaga sida 2 rutor (SKV 2161), with the form's wording. */
const NE_RUTA_ROWS: Array<{ ruta: keyof EfNeRutor; label: string; sum?: boolean }> = [
  ...EF_NE_BOOKED_ROWS,
  { ruta: 'R29', label: 'Överskott/underskott före räntefördelning', sum: true },
  { ruta: 'R30', label: 'Positiv räntefördelning' },
  { ruta: 'R31', label: 'Negativ räntefördelning' },
  { ruta: 'R32', label: 'Återföring av periodiseringsfond' },
  { ruta: 'R33', label: 'Överskott/underskott före avsättning till periodiseringsfond', sum: true },
  { ruta: 'R34', label: 'Avsättning till periodiseringsfond' },
  { ruta: 'R35', label: 'Överskott/underskott före ökning av expansionsfond', sum: true },
  { ruta: 'R36', label: 'Ökning av expansionsfond' },
  { ruta: 'R37', label: 'Minskning av expansionsfond' },
  { ruta: 'R40', label: 'Medgivna avdrag för egenavgifter föregående beskattningsår' },
  { ruta: 'R41', label: 'Påförda egenavgifter enligt slutskattebesked' },
  { ruta: 'R42', label: 'Överskott/underskott före årets avdrag för egenavgifter', sum: true },
  { ruta: 'R43', label: 'Årets beräknade avdrag för egenavgifter' },
]

/** A figure as typed, or undefined when it is not a number. */
function typedNumber(value: string): number | undefined {
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * The form as the stored inputs (NeDeclarationInputs): the same figures the
 * preview query carries, with what is not a number left out.
 */
function toInputs(o: EfOverrideInputs): NeDeclarationInputs {
  const fonder = enteredFonder(o.pfondFonder).map((f) => ({ cohort_year: Number(f.year), balance: Number(f.balance) }))
  const entries: Array<[keyof NeDeclarationInputs, number | undefined]> = [
    ['kapitalunderlag', typedNumber(o.kapitalunderlag)],
    ['sparatFordelningsbelopp', typedNumber(o.sparatFordelningsbelopp)],
    ['expansionsfondKapitalunderlag', typedNumber(o.expansionsfondKapitalunderlag)],
    ['priorYearSchablonavdrag', typedNumber(o.priorSchablon)],
    ['priorYearActualCharged', typedNumber(o.priorActual)],
    ['pfondDesiredAmount', typedNumber(o.pfondDesired)],
    ['expansionsfondExistingBalance', typedNumber(o.expansionsfondBalance)],
    ['expansionsfondDesiredChange', typedNumber(o.expansionsfondChange)],
  ]
  const inputs: NeDeclarationInputs = { category: o.category }
  for (const [key, value] of entries) {
    // The server refuses a negative figure where none can be negative; the
    // field keeps what was typed, and the preview says what is wrong.
    if (value === undefined) continue
    if (key !== 'kapitalunderlag' && key !== 'expansionsfondKapitalunderlag' && key !== 'expansionsfondDesiredChange' && value < 0) continue
    ;(inputs as Record<string, number>)[key] = value
  }
  if (fonder.length > 0) inputs.pfondExistingFonder = fonder.slice(0, 10)
  return inputs
}

/** The stored inputs as the form's text fields. */
function fromInputs(i: NeDeclarationInputs): EfOverrideInputs {
  const text = (n: number | undefined) => (n === undefined ? '' : String(n))
  return {
    category: i.category ?? 'full',
    kapitalunderlag: text(i.kapitalunderlag),
    sparatFordelningsbelopp: text(i.sparatFordelningsbelopp),
    expansionsfondKapitalunderlag: text(i.expansionsfondKapitalunderlag),
    priorSchablon: text(i.priorYearSchablonavdrag),
    priorActual: text(i.priorYearActualCharged),
    pfondDesired: text(i.pfondDesiredAmount),
    pfondFonder: (i.pfondExistingFonder ?? []).map((f) => ({ year: String(f.cohort_year), balance: String(f.balance) })),
    expansionsfondBalance: text(i.expansionsfondExistingBalance),
    expansionsfondChange: text(i.expansionsfondDesiredChange),
  }
}

/** What an earlier version kept in this browser for the year, if anything. */
function legacyOverrides(storageKey: string): EfOverrideInputs | null {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<EfOverrideInputs>
    return {
      ...DEFAULT_OVERRIDES,
      ...parsed,
      pfondFonder: Array.isArray(parsed.pfondFonder) ? parsed.pfondFonder : [],
    }
  } catch {
    // Safe to ignore: storage disabled or an unreadable old value means there
    // is nothing to take over, and the form starts from its defaults.
    return null
  }
}

/** Rows with a valid year and a positive balance; a repeated year counts once. */
function enteredFonder(rows: Array<{ year: string; balance: string }>): Array<{ year: string; balance: string }> {
  const seen = new Set<string>()
  const out: Array<{ year: string; balance: string }> = []
  for (const row of rows) {
    const year = row.year.trim()
    const balance = parseFloat(row.balance)
    if (!isFiscalYear(year) || !(balance > 0) || seen.has(year)) continue
    seen.add(year)
    out.push({ year, balance: String(roundOre(balance)) })
  }
  return out
}

function FondStatusLine({
  row,
  rows,
  index,
  states,
  fiscalYear,
}: {
  row: { year: string; balance: string }
  rows: Array<{ year: string; balance: string }>
  index: number
  states: EfFondState[]
  fiscalYear: number
}) {
  const year = row.year.trim()
  if (!isFiscalYear(year)) return null
  const repeated = rows.slice(0, index).some((other) => other.year.trim() === year)
  if (repeated) {
    return <p className="col-span-3 text-xs text-attn">Året finns redan i listan och räknas en gång.</p>
  }
  const state = states.find((s) => s.cohort_year === Number(year))
  if (!state) return null
  const text =
    state.status === 'mandatory'
      ? `Återförs i år (senast ${state.latest_return_year}).`
      : state.status === 'overdue'
        ? `Skulle ha återförts senast ${state.latest_return_year}: återförs nu.`
        : state.status === 'optional'
          ? `Kan återföras frivilligt, senast ${state.latest_return_year}.`
          : `Avsättningsåret måste vara före ${fiscalYear}.`
  const attention = state.status === 'overdue' || state.status === 'invalid'
  return <p className={`col-span-3 text-xs ${attention ? 'text-attn' : 'text-muted-foreground'}`}>{text}</p>
}
