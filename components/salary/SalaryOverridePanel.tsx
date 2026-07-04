'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Settings2, Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency } from '@/lib/utils'

interface SalaryOverridePanelProps {
  runId: string
  employeeId: string
  taxWithheld: number
  taxOverride: number | null
  avgifterAmount: number
  avgifterOverride: number | null
  avgifterBasis: number
  avgifterBasisOverride: number | null
  reason: string | null
  onSaved: () => void
  disabled?: boolean
}

function num(v: string): number | null {
  const trimmed = v.trim()
  if (!trimmed) return null
  const n = Number(trimmed.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

export function SalaryOverridePanel(props: SalaryOverridePanelProps) {
  const { toast } = useToast()
  const [expanded, setExpanded] = useState(
    props.taxOverride !== null ||
      props.avgifterOverride !== null ||
      props.avgifterBasisOverride !== null,
  )
  const [taxStr, setTaxStr] = useState(props.taxOverride !== null ? String(props.taxOverride) : '')
  const [avgStr, setAvgStr] = useState(
    props.avgifterOverride !== null ? String(props.avgifterOverride) : '',
  )
  const [basisStr, setBasisStr] = useState(
    props.avgifterBasisOverride !== null ? String(props.avgifterBasisOverride) : '',
  )
  const [reason, setReason] = useState(props.reason ?? '')
  const [saving, setSaving] = useState(false)

  const hasOverride =
    props.taxOverride !== null ||
    props.avgifterOverride !== null ||
    props.avgifterBasisOverride !== null

  async function handleSave() {
    setSaving(true)
    try {
      const body = {
        tax_withheld_override: num(taxStr),
        avgifter_amount_override: num(avgStr),
        avgifter_basis_override: num(basisStr),
        reason: reason.trim() || null,
      }
      const res = await fetch(`/api/salary/runs/${props.runId}/employees/${props.employeeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte spara justering',
          description: typeof data?.error === 'string' ? data.error : 'Okänt fel',
          variant: 'destructive',
        })
        return
      }
      toast({ title: 'Justering sparad' })
      props.onSaved()
    } catch (err) {
      toast({
        title: 'Kunde inte spara justering',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleClear() {
    setSaving(true)
    try {
      const res = await fetch(`/api/salary/runs/${props.runId}/employees/${props.employeeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tax_withheld_override: null,
          avgifter_amount_override: null,
          avgifter_basis_override: null,
          reason: null,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        toast({
          title: 'Kunde inte rensa justering',
          description: typeof data?.error === 'string' ? data.error : 'Okänt fel',
          variant: 'destructive',
        })
        return
      }
      setTaxStr('')
      setAvgStr('')
      setBasisStr('')
      setReason('')
      toast({ title: 'Justering rensad' })
      props.onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Avancerat läge</CardTitle>
          {hasOverride && <Badge variant="warning">Justerat</Badge>}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          disabled={props.disabled}
        >
          <Settings2 className="mr-1.5 h-3.5 w-3.5" />
          {expanded ? 'Dölj' : 'Visa'}
        </Button>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Justera skatteavdrag eller arbetsgivaravgift för den här anställde, t.ex. för FoU-avdrag eller
            jämkning. Justerade värden används vid bokföring och AGI-rapportering. Endast tillåtet i
            granskningsläge.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="tax_override" className="text-xs">
                Skatteavdrag (kr)
              </Label>
              <Input
                id="tax_override"
                inputMode="decimal"
                placeholder={String(props.taxWithheld)}
                value={taxStr}
                onChange={(e) => setTaxStr(e.target.value)}
                disabled={props.disabled || saving}
                className="tabular-nums"
              />
              <p className="text-[11px] text-muted-foreground">
                Beräknat: <span className="tabular-nums">{formatCurrency(props.taxWithheld)}</span>
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="avgifter_override" className="text-xs">
                Arbetsgivaravgifter (kr)
              </Label>
              <Input
                id="avgifter_override"
                inputMode="decimal"
                placeholder={String(props.avgifterAmount)}
                value={avgStr}
                onChange={(e) => setAvgStr(e.target.value)}
                disabled={props.disabled || saving}
                className="tabular-nums"
              />
              <p className="text-[11px] text-muted-foreground">
                Beräknat: <span className="tabular-nums">{formatCurrency(props.avgifterAmount)}</span>
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="avgifter_basis_override" className="text-xs">
                Avgiftsunderlag (kr)
              </Label>
              <Input
                id="avgifter_basis_override"
                inputMode="decimal"
                placeholder={String(props.avgifterBasis)}
                value={basisStr}
                onChange={(e) => setBasisStr(e.target.value)}
                disabled={props.disabled || saving}
                className="tabular-nums"
              />
              <p className="text-[11px] text-muted-foreground">
                Beräknat: <span className="tabular-nums">{formatCurrency(props.avgifterBasis)}</span>
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="override_reason" className="text-xs">
              Anledning (krävs vid justering)
            </Label>
            <Textarea
              id="override_reason"
              rows={2}
              placeholder="T.ex. FoU-avdrag 10 % på arbetsgivaravgifter, jämkning enligt beslut från Skatteverket"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={props.disabled || saving}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={handleSave} disabled={props.disabled || saving}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Spara justering
            </Button>
            {hasOverride && (
              <Button
                variant="outline"
                onClick={handleClear}
                disabled={props.disabled || saving}
              >
                Rensa justering
              </Button>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  )
}
