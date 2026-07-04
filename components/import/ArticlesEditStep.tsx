'use client'

import { useMemo, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Trash2, AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ArticleType } from '@/types'
import type { AnnotatedArticleRow } from '@/lib/import/articles/types'

let idCounter = 0
const newId = () => `art_row_${++idCounter}_${Date.now()}`

interface EditableArticleRow extends AnnotatedArticleRow {
  id: string
}

interface ArticlesEditStepProps {
  rows: AnnotatedArticleRow[]
  onExecute: (rows: AnnotatedArticleRow[], updateDuplicates: boolean) => void
  onBack: () => void
  isLoading: boolean
  error: string | null
}

const TYPE_LABELS: Record<ArticleType, string> = {
  vara: 'Vara',
  tjanst: 'Tjänst',
}

const VAT_RATES = [25, 12, 6, 0] as const

export default function ArticlesEditStep({
  rows: initialRows,
  onExecute,
  onBack,
  isLoading,
  error,
}: ArticlesEditStepProps) {
  const [rows, setRows] = useState<EditableArticleRow[]>(() =>
    initialRows.map((r) => ({ ...r, id: newId() })),
  )
  const [updateDuplicates, setUpdateDuplicates] = useState(false)

  const liveDuplicateCount = useMemo(
    () => rows.filter((r) => r.duplicate_match !== null).length,
    [rows],
  )

  const newCount = rows.length - liveDuplicateCount

  const hasErrors = useMemo(() => rows.some((r) => !r.is_valid), [rows])

  const adjustedVatCount = useMemo(
    () => rows.filter((r) => r.vat_rate_adjusted).length,
    [rows],
  )

  const canContinue = rows.length > 0 && !hasErrors && !isLoading

  const updateRow = useCallback((id: string, updates: Partial<EditableArticleRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)))
  }, [])

  const deleteRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const handlePriceChange = useCallback((id: string, raw: string) => {
    const n = parseFloat(raw.replace(',', '.'))
    const price = Number.isFinite(n) ? n : 0
    updateRow(id, {
      price_excl_vat: price,
      is_valid: price >= 0,
      validation_errors: price < 0 ? ['Priset kan inte vara negativt'] : [],
    })
  }, [updateRow])

  const handleExecute = () => {
    if (!canContinue) return
    const stripped: AnnotatedArticleRow[] = rows.map(({ id: _id, ...rest }) => rest)
    onExecute(stripped, updateDuplicates)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Granska artiklar</CardTitle>
        <CardDescription>
          Kontrollera att uppgifterna stämmer. Du kan justera benämning, typ, pris och moms
          inline, eller ta bort rader. {newCount} ny{newCount === 1 ? '' : 'a'} artik{newCount === 1 ? 'el' : 'lar'} skapas
          {liveDuplicateCount > 0 ? ` och ${liveDuplicateCount} matchar befintliga.` : '.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Duplicate handling banner */}
        {liveDuplicateCount > 0 && (
          <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
            <RefreshCw className="h-4 w-4 text-warning mt-0.5 shrink-0" />
            <div className="flex-1 space-y-2">
              <p className="text-sm">
                <span className="font-medium">{liveDuplicateCount} rader</span> matchar befintliga
                artiklar (på artikelnummer eller benämning).
              </p>
              <div className="flex items-center gap-3">
                <Switch
                  id="update-duplicates"
                  checked={updateDuplicates}
                  onCheckedChange={setUpdateDuplicates}
                />
                <Label htmlFor="update-duplicates" className="text-sm cursor-pointer">
                  {updateDuplicates
                    ? 'Uppdatera befintliga artiklar med ny information'
                    : 'Hoppa över befintliga artiklar'}
                </Label>
              </div>
              {updateDuplicates && (
                <p className="text-xs text-muted-foreground">
                  Endast fält med värden i filen skrivs över. Typ, enhet och moms lämnas orörda.
                </p>
              )}
            </div>
          </div>
        )}

        {/* VAT-adjustment notice: rows whose rate was snapped/defaulted */}
        {adjustedVatCount > 0 && (
          <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
            <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
            <p className="text-sm">
              <span className="font-medium">{adjustedVatCount} rad{adjustedVatCount === 1 ? '' : 'er'}</span> fick
              momssatsen omtolkad (avrundad till närmaste giltiga, eller satt till 25 %).
              Kontrollera de markerade raderna innan du importerar: fel momssats ger fel moms på fakturan.
            </p>
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-2 text-left w-28">Art.nr</th>
                <th className="px-3 py-2 text-left">Benämning</th>
                <th className="px-3 py-2 text-left w-28">Typ</th>
                <th className="px-3 py-2 text-right w-28">Pris exkl moms</th>
                <th className="px-3 py-2 text-left w-24">Moms</th>
                <th className="px-3 py-2 text-left w-28">Status</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={cn('border-b last:border-0', !row.is_valid && 'bg-destructive/5')}
                >
                  <td className="px-3 py-1.5 text-muted-foreground tabular-nums">
                    {row.article_number || 'Auto'}
                  </td>
                  <td className="px-3 py-1.5">
                    <Input
                      value={row.name}
                      onChange={(e) => updateRow(row.id, { name: e.target.value })}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <Select
                      value={row.type}
                      onValueChange={(v) => updateRow(row.id, { type: v as ArticleType })}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(TYPE_LABELS) as ArticleType[]).map((t) => (
                          <SelectItem key={t} value={t}>
                            {TYPE_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-1.5">
                    <Input
                      value={String(row.price_excl_vat)}
                      inputMode="decimal"
                      onChange={(e) => handlePriceChange(row.id, e.target.value)}
                      className="h-8 text-right tabular-nums"
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <Select
                        value={String(row.vat_rate)}
                        onValueChange={(v) =>
                          updateRow(row.id, { vat_rate: Number(v), vat_rate_adjusted: false })
                        }
                      >
                        <SelectTrigger
                          className={cn('h-8', row.vat_rate_adjusted && 'border-warning text-warning')}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {VAT_RATES.map((r) => (
                            <SelectItem key={r} value={String(r)}>
                              {r} %
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {row.vat_rate_adjusted && (
                        <span
                          className="text-warning shrink-0"
                          title="Momssatsen tolkades om från filen: kontrollera att den stämmer."
                        >
                          <AlertTriangle className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </div>
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
                            'text-[11px] font-medium px-1.5 py-0.5 rounded',
                            updateDuplicates
                              ? 'bg-warning/15 text-warning'
                              : 'bg-muted text-muted-foreground',
                          )}
                          title={`Matchar ${row.duplicate_match.existing_name} (${row.duplicate_match.matched_by})`}
                        >
                          {updateDuplicates ? 'Uppdateras' : 'Hoppas över'}
                        </span>
                      ) : (
                        <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-success/15 text-success">
                          Ny
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label="Ta bort rad"
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

        {hasErrors && (
          <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
            <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
            <p className="text-sm text-warning">
              Vissa rader har valideringsfel (markerade i rött). Åtgärda eller ta bort dem
              innan du fortsätter.
            </p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={onBack} disabled={isLoading}>
            Tillbaka
          </Button>
          <Button onClick={handleExecute} disabled={!canContinue}>
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Importerar...
              </>
            ) : (
              `Importera ${rows.length} rad${rows.length === 1 ? '' : 'er'}`
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
