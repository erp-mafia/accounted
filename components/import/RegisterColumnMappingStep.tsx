'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'

/** A field that can be mapped to a column in the uploaded file. */
export interface RegisterColumnSpec<K extends string> {
  key: K
  label: string
  required: boolean
}

interface RegisterColumnMappingStepProps<K extends string> {
  headers: string[]
  previewRows: string[][]
  specs: RegisterColumnSpec<K>[]
  initial: Record<K, number | null>
  onConfirm: (mapping: Record<K, number | null>) => void
  onBack: () => void
}

export default function RegisterColumnMappingStep<K extends string>({
  headers,
  previewRows,
  specs,
  initial,
  onConfirm,
  onBack,
}: RegisterColumnMappingStepProps<K>) {
  const [mapping, setMapping] = useState<Record<K, number | null>>(initial)

  const columnOptions = headers.map((h, i) => ({
    value: String(i),
    label: `${i + 1}: ${h || '(tom)'}`,
  }))

  const canContinue = specs
    .filter((s) => s.required)
    .every((s) => mapping[s.key] !== null && mapping[s.key]! >= 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Kolumnmappning</CardTitle>
        <CardDescription>
          Vi kunde inte automatiskt identifiera alla kolumner. Ange vilka kolumner i din fil
          som motsvarar respektive fält. Lämna tomt för fält som inte finns.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {specs.map((spec) => (
            <div key={spec.key} className="space-y-2">
              <Label>
                {spec.label}
                {spec.required && ' *'}
              </Label>
              <Select
                value={mapping[spec.key] !== null ? String(mapping[spec.key]) : 'none'}
                onValueChange={(v) =>
                  setMapping((prev) => ({
                    ...prev,
                    [spec.key]: v === 'none' ? null : Number(v),
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Välj kolumn" />
                </SelectTrigger>
                <SelectContent>
                  {!spec.required && <SelectItem value="none">(ingen)</SelectItem>}
                  {columnOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>

        {previewRows.length > 0 && (
          <div className="space-y-2">
            <Label className="text-muted-foreground">Förhandsgranskning (5 första raderna)</Label>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b">
                    {headers.map((h, i) => (
                      /* data-ph-mask: CSV headers are user data */
                      <th key={i} data-ph-mask="" className="px-3 py-2 text-left whitespace-nowrap">
                        {h || `Kolumn ${i + 1}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.slice(0, 5).map((row, ri) => (
                    <tr key={ri} className="border-b last:border-0">
                      {row.map((cell, ci) => (
                        <td key={ci} className="px-3 py-1.5 whitespace-nowrap">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="flex justify-between">
          <Button variant="ghost" onClick={onBack}>Tillbaka</Button>
          <Button onClick={() => onConfirm(mapping)} disabled={!canContinue}>
            Fortsätt
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
