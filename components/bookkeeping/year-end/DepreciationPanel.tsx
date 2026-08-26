'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Loader2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import Link from 'next/link'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import type { Asset } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

interface ProposalItem {
  asset: Asset
  amount: number
  netBookValueAfter: number
  proRated: boolean
  existingScheduleId?: string
  existingJournalEntryId?: string | null
}

interface Proposal {
  fiscalPeriod: { id: string; name: string; period_start: string; period_end: string }
  items: ProposalItem[]
  totalAmount: number
}

type TaxMethod = 'rakenskapsenlig' | 'restvarde'
type TaxRule = 'huvudregel_30' | 'kompletteringsregel_20'

interface TaxAlternative {
  rule: TaxRule | 'restvarde_25'
  rate: number | null
  deduction: number
  closingTaxValue: number
}

interface TaxResult {
  openingTaxValue: number
  additions: number
  disposals: number
  basis: number
  maximumDeduction: number
  deduction: number
  closingTaxValue: number
  excessDisposals: number
  alternatives: TaxAlternative[]
}

interface TaxView {
  status:
    | 'needs_previous_period'
    | 'needs_period_history'
    | 'needs_method'
    | 'needs_opening_value'
    | 'needs_rule'
    | 'ready'
  method: TaxMethod | null
  selectedRule: TaxRule | null
  methodLocked: boolean
  openingTaxValue: number | null
  openingSource: 'saved' | 'previous_period' | 'previous_period_required' | 'manual_required'
  periodMonths: number
  eligibleAssetCount: number
  excludedAssetCount: number
  excludedCategories: string[]
  cohortHistoryComplete: boolean
  incompleteCohortCount: number
  result: TaxResult | null
  snapshot: { deduction: number } | null
  isStale: boolean
}

interface DepreciationPanelProps {
  periodId: string
  /** Called after a successful post: parent refetches dispositions because
   *  posted avskrivningar change the result which affects bolagsskatt etc. */
  onPosted: () => void
  onTaxDirtyChange?: (dirty: boolean) => void
}

export function DepreciationPanel({ periodId, onPosted, onTaxDirtyChange }: DepreciationPanelProps) {
  const { toast } = useToast()
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [tax, setTax] = useState<TaxView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)
  const [taxDirty, setTaxDirty] = useState(false)

  const handleTaxDirtyChange = useCallback((dirty: boolean) => {
    setTaxDirty(dirty)
    onTaxDirtyChange?.(dirty)
  }, [onTaxDirtyChange])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/depreciation`)
      const body = await res.json()
      if (!res.ok) {
        setError(getUserErrorMessage(body?.error) ?? 'Kunde inte ladda avskrivningar')
        return
      }
      setProposal(body.data as Proposal)
      setTax(body.data.tax as TaxView)
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel')
    } finally {
      setLoading(false)
    }
  }, [periodId])

  useEffect(() => {
    void load()
  }, [load])

  const handlePost = useCallback(async () => {
    if (taxDirty) {
      setError('Spara eller återställ ändringarna i skattemässig avskrivning först.')
      return
    }
    setPosting(true)
    try {
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/depreciation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(getUserErrorMessage(body?.error) ?? 'Kunde inte bokföra avskrivningar')
        return
      }
      const posted = body.data?.posted?.length ?? 0
      toast({
        title: `${posted} avskrivning${posted === 1 ? '' : 'ar'} bokförd${
          posted === 1 ? '' : 'a'
        }`,
      })
      onPosted()
      await load()
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel')
    } finally {
      setPosting(false)
    }
  }, [periodId, onPosted, load, toast, taxDirty])

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-2">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-destructive">{error}</CardContent>
      </Card>
    )
  }

  if (!proposal) return null

  const taxPanel = tax ? (
    <TaxDepreciationCard
      periodId={periodId}
      view={tax}
      onSaved={load}
      onDirtyChange={handleTaxDirtyChange}
    />
  ) : null

  const allPosted =
    proposal.items.length > 0 && proposal.items.every((i) => Boolean(i.existingJournalEntryId))
  const anyPending =
    proposal.items.length > 0 && proposal.items.some((i) => !i.existingJournalEntryId)

  if (proposal.items.length === 0) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Planenliga avskrivningar</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Inga aktiva anläggningstillgångar att skriva av.{' '}
            <Link href="/assets" className="text-primary hover:underline">
              Lägg till tillgångar
            </Link>{' '}
            så räknar bokslutet ut avskrivningarna automatiskt.
          </CardContent>
        </Card>
        {taxPanel}
      </div>
    )
  }

  return (
    <div className="space-y-4">
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <CardTitle className="text-base">Planenliga avskrivningar</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {proposal.items.length} tillgång{proposal.items.length === 1 ? '' : 'ar'}.
              {allPosted ? ' Allt redan bokfört.' : ' Bokförs som separata verifikationer.'}
            </p>
          </div>
          <p className="font-display text-2xl tabular-nums shrink-0">
            {formatCurrency(proposal.totalAmount)}
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tillgång</TableHead>
              <TableHead className="text-right">Avskrivning</TableHead>
              <TableHead className="text-right">Restvärde</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {proposal.items.map((item) => (
              <TableRow key={item.asset.id}>
                <TableCell className="text-sm">{item.asset.name}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(item.amount)}
                  {item.proRated && (
                    <span className="block text-[10px] text-muted-foreground">pro-rata</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(item.netBookValueAfter)}
                </TableCell>
                <TableCell>
                  {item.existingJournalEntryId ? (
                    <Badge variant="success">Bokförd</Badge>
                  ) : (
                    <Badge variant="outline">Föreslagen</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {anyPending && (
          <div className="flex justify-end">
            <Button onClick={handlePost} disabled={posting || taxDirty}>
              {posting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Bokför…
                </>
              ) : (
                'Bokför alla avskrivningar'
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
    {taxPanel}
    </div>
  )
}

function TaxDepreciationCard({
  periodId,
  view,
  onSaved,
  onDirtyChange,
}: {
  periodId: string
  view: TaxView
  onSaved: () => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}) {
  const { toast } = useToast()
  const [method, setMethod] = useState<TaxMethod>(view.method ?? 'rakenskapsenlig')
  const [rule, setRule] = useState<TaxRule>(view.selectedRule ?? 'huvudregel_30')
  const [openingValue, setOpeningValue] = useState(
    view.openingTaxValue === null ? '' : String(view.openingTaxValue),
  )
  const [electedDeduction, setElectedDeduction] = useState(
    view.snapshot ? String(view.snapshot.deduction) : '',
  )
  const [bookConformityConfirmed, setBookConformityConfirmed] = useState(false)
  const [preview, setPreview] = useState<TaxView | null>(null)
  const [dirty, setDirty] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const saveSequence = useRef(0)

  useEffect(() => {
    requestVersion.current += 1
    setMethod(view.method ?? 'rakenskapsenlig')
    setRule(view.selectedRule ?? 'huvudregel_30')
    setOpeningValue(view.openingTaxValue === null ? '' : String(view.openingTaxValue))
    setElectedDeduction(view.snapshot ? String(view.snapshot.deduction) : '')
    setBookConformityConfirmed(false)
    setPreview(null)
    setDirty(false)
  }, [view])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  const resetCalculatedDraft = () => {
    setPreview(null)
    setElectedDeduction('')
    setBookConformityConfirmed(false)
    setSaveError(null)
    setDirty(true)
  }

  const restoreSavedValues = () => {
    requestVersion.current += 1
    setMethod(view.method ?? 'rakenskapsenlig')
    setRule(view.selectedRule ?? 'huvudregel_30')
    setOpeningValue(view.openingTaxValue === null ? '' : String(view.openingTaxValue))
    setElectedDeduction(view.snapshot ? String(view.snapshot.deduction) : '')
    setBookConformityConfirmed(false)
    setPreview(null)
    setPreviewing(false)
    setSaving(false)
    setSaveError(null)
    setDirty(false)
  }

  const parseOpening = (): number | null => {
    if (openingValue.trim() === '') {
      setSaveError('Ange skattemässigt värde vid årets ingång.')
      return null
    }
    const opening = Number(openingValue.replace(',', '.'))
    if (!Number.isFinite(opening) || opening < 0) {
      setSaveError('Ange ett ingående skattemässigt värde på 0 kr eller mer.')
      return null
    }
    return opening
  }

  const loadPreview = async () => {
    setSaveError(null)
    const opening = parseOpening()
    if (opening === null) return
    setDirty(true)
    setPreviewing(true)
    const version = ++requestVersion.current
    try {
      const query = new URLSearchParams({
        tax_method: method,
        opening_tax_value: String(opening),
      })
      if (method === 'rakenskapsenlig') query.set('tax_rule', rule)
      const response = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/depreciation?${query.toString()}`,
      )
      const body = await response.json()
      if (version !== requestVersion.current) return
      if (!response.ok) {
        setSaveError(getUserErrorMessage(body?.error ?? body) ?? 'Kunde inte beräkna förslaget')
        return
      }
      const nextPreview = body.data.tax as TaxView
      setPreview(nextPreview)
      setElectedDeduction(
        nextPreview.result ? String(nextPreview.result.maximumDeduction) : '',
      )
      setBookConformityConfirmed(false)
      setDirty(true)
    } catch (err) {
      if (version !== requestVersion.current) return
      setSaveError(err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel')
    } finally {
      if (version === requestVersion.current) setPreviewing(false)
    }
  }

  const save = async () => {
    setSaveError(null)
    const opening = parseOpening()
    if (opening === null) return
    const calculation = preview ?? (dirty && view.result ? view : null)
    if (!calculation?.result) {
      setSaveError('Beräkna förslaget innan valet sparas.')
      return
    }
    if (electedDeduction.trim() === '') {
      setSaveError('Ange årets faktiska skattemässiga avdrag.')
      return
    }
    const deduction = Number(electedDeduction.replace(',', '.'))
    if (!Number.isFinite(deduction) || deduction < 0) {
      setSaveError('Årets faktiska avdrag måste vara 0 kr eller mer.')
      return
    }
    if (deduction > calculation.result.maximumDeduction) {
      setSaveError('Avdraget får inte överstiga högsta avdrag enligt den valda regeln.')
      return
    }
    if (method === 'rakenskapsenlig' && !bookConformityConfirmed) {
      setSaveError('Bekräfta att avdraget motsvarar bokslutets totala avskrivning.')
      return
    }
    setSaving(true)
    const version = ++requestVersion.current
    const saveId = ++saveSequence.current
    try {
      const response = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/depreciation`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method,
          ...(method === 'rakenskapsenlig' ? { selected_rule: rule } : {}),
          opening_tax_value: opening,
          elected_deduction: deduction,
          ...(method === 'rakenskapsenlig'
            ? { book_conformity_confirmed: bookConformityConfirmed }
            : {}),
        }),
      })
      const body = await response.json()
      if (version !== requestVersion.current) return
      if (!response.ok) {
        setSaveError(getUserErrorMessage(body?.error) ?? 'Kunde inte spara beräkningen')
        return
      }
      toast({ title: 'Skattemässig avskrivning sparad' })
      setDirty(false)
      await onSaved()
    } catch (err) {
      if (version !== requestVersion.current) return
      setSaveError(err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel')
    } finally {
      // A successful save triggers onSaved -> parent load -> new view prop,
      // which bumps requestVersion before this finally runs. Gate on the
      // save sequence instead so the card never stays stuck busy after its
      // own save completes.
      if (saveId === saveSequence.current) setSaving(false)
    }
  }

  const calculation = dirty ? preview : view
  const result = calculation?.result ?? null
  const controlsBusy = previewing || saving
  const formBlocked = view.openingSource === 'previous_period_required'

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Skattemässig avskrivning</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Beräkna högsta avdrag för den gemensamma inventariepoolen enligt IL 18 kap.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Du sparar det faktiska avdraget efter avstämning. Eventuell överavskrivning
              bokförs separat.
            </p>
          </div>
          {dirty && <Badge variant="warning">Ej sparad</Badge>}
          {!dirty && view.snapshot && !view.isStale && (
            <span className="text-xs text-muted-foreground">Sparad</span>
          )}
          {!dirty && view.isStale && <Badge variant="warning">Behöver sparas om</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {view.openingSource === 'previous_period_required' && (
          <p className="text-sm text-destructive" role="alert">
            Spara skattemässig avskrivning för närmast föregående räkenskapsår först. Ett osparat
            mellanår får inte hoppas över.
          </p>
        )}
        {view.status === 'needs_period_history' && (
          <p className="text-sm text-destructive" role="alert">
            Kompletteringsregeln kan inte beräknas utan fullständig räkenskapsårshistorik för
            alla kvarvarande inventarier. Välj huvudregeln eller komplettera periodhistoriken.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="tax-depreciation-method">Metod</Label>
            <Select
              value={method}
              onValueChange={(value) => {
                setMethod(value as TaxMethod)
                resetCalculatedDraft()
              }}
              disabled={view.methodLocked || controlsBusy || formBlocked}
            >
              <SelectTrigger id="tax-depreciation-method"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="rakenskapsenlig">Räkenskapsenlig</SelectItem>
                <SelectItem value="restvarde">Restvärdeavskrivning</SelectItem>
              </SelectContent>
            </Select>
            {view.methodLocked && (
              <p className="text-xs text-muted-foreground">
                Metoden följer föregående sparade år. Ett byte kräver en separat övergångsbedömning.
              </p>
            )}
          </div>
          {method === 'rakenskapsenlig' && (
            <div className="space-y-2">
              <Label htmlFor="tax-depreciation-rule">Årets regel</Label>
              <Select
                value={rule}
                onValueChange={(value) => {
                  setRule(value as TaxRule)
                  resetCalculatedDraft()
                }}
                disabled={controlsBusy || formBlocked}
              >
                <SelectTrigger id="tax-depreciation-rule"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="huvudregel_30">Huvudregeln 30 %</SelectItem>
                  <SelectItem value="kompletteringsregel_20">Kompletteringsregeln 20 %</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="tax-opening-value">Skattemässigt värde vid ingången</Label>
            <Input
              id="tax-opening-value"
              type="number"
              min="0"
              step="0.01"
              value={openingValue}
              onChange={(event) => {
                setOpeningValue(event.target.value)
                resetCalculatedDraft()
              }}
              disabled={
                view.openingSource === 'previous_period'
                || formBlocked
                || controlsBusy
              }
              className="tabular-nums"
            />
            {view.openingSource === 'previous_period' && (
              <p className="text-xs text-muted-foreground">Hämtat från föregående sparade år.</p>
            )}
          </div>
        </div>

        {dirty && !preview && (
          <p className="rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
            Inställningarna är ändrade. Beräkna förslaget för att se rätt gränsbelopp innan du
            sparar.
          </p>
        )}

        {result && (
          <>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-border bg-muted/20 p-4 text-sm sm:grid-cols-3">
              <TaxValue label="Ingående värde" value={result.openingTaxValue} />
              <TaxValue label="Årets anskaffningar" value={result.additions} />
              <TaxValue label="Årets avyttringar" value={-result.disposals} />
              <TaxValue label="Avskrivningsunderlag" value={result.basis} />
              <TaxValue label="Högsta avdrag" value={-result.maximumDeduction} />
              {!dirty && view.snapshot ? (
                <TaxValue label="Faktiskt sparat avdrag" value={-result.deduction} strong />
              ) : (
                <TaxValue label="Lägsta skattemässigt värde" value={result.closingTaxValue} strong />
              )}
            </div>
            {method === 'rakenskapsenlig' && (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Jämförelse
                </p>
                {result.alternatives.map((alternative) => (
                  <div key={alternative.rule} className="flex justify-between text-sm">
                    <span>{alternative.rule === 'huvudregel_30' ? '30-procentsregeln' : '20-procentsregeln'}</span>
                    <span className="tabular-nums">
                      {formatCurrency(alternative.closingTaxValue)} kvar
                    </span>
                  </div>
                ))}
              </div>
            )}
            {dirty && (
              <div className="space-y-2">
                <Label htmlFor="tax-elected-deduction">Faktiskt avdrag efter avstämning</Label>
                <Input
                  id="tax-elected-deduction"
                  type="number"
                  min="0"
                  max={result.maximumDeduction}
                  step="0.01"
                  value={electedDeduction}
                  onChange={(event) => setElectedDeduction(event.target.value)}
                  disabled={controlsBusy}
                  className="max-w-xs tabular-nums"
                />
                <p className="text-xs text-muted-foreground">
                  Beloppet får vara lägre än gränsbeloppet men aldrig högre.
                </p>
              </div>
            )}
            {dirty && method === 'rakenskapsenlig' && (
              <div className="flex items-start gap-2 rounded-lg border border-border p-3">
                <Checkbox
                  id="tax-book-conformity"
                  checked={bookConformityConfirmed}
                  onCheckedChange={(checked) => setBookConformityConfirmed(checked === true)}
                  disabled={controlsBusy}
                />
                <Label htmlFor="tax-book-conformity" className="cursor-pointer text-sm leading-5">
                  Jag har stämt av att det faktiska avdraget motsvarar bokslutets totala
                  avskrivning, inklusive eventuell bokförd överavskrivning.
                </Label>
              </div>
            )}
          </>
        )}

        {view.excludedAssetCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {view.excludedAssetCount} tillgång{view.excludedAssetCount === 1 ? '' : 'ar'} i andra
            kategorier ingår inte i inventariepoolen och måste bedömas separat.
          </p>
        )}
        {result && result.excessDisposals > 0 && (
          <p className="text-xs text-destructive">
            Avyttringsersättningen överstiger underlaget med {formatCurrency(result.excessDisposals)}.
            Överskjutande belopp behöver hanteras i deklarationen.
          </p>
        )}
        {saveError && <p className="text-sm text-destructive" role="alert">{saveError}</p>}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {view.eligibleAssetCount} tillgång{view.eligibleAssetCount === 1 ? '' : 'ar'} i poolen,
            {view.periodMonths} månader i räkenskapsåret.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            {dirty && (
              <Button
                type="button"
                variant="ghost"
                onClick={restoreSavedValues}
                disabled={controlsBusy}
                className="w-full sm:w-auto"
              >
                Återställ
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={loadPreview}
              disabled={
                previewing
                || saving
                || formBlocked
              }
              className="w-full sm:w-auto"
            >
              {previewing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Beräkna förslag
            </Button>
            <Button
              type="button"
              onClick={save}
              disabled={
                saving
                || !dirty
                || !result
                || formBlocked
              }
              className="w-full sm:w-auto"
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Spara faktiskt avdrag
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function TaxValue({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`tabular-nums ${strong ? 'font-medium' : ''}`}>{formatCurrency(value)}</p>
    </div>
  )
}
