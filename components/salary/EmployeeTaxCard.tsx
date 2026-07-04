'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import MunicipalityCombobox from './MunicipalityCombobox'
import { TAX_COLUMN_OPTIONS, deriveTaxColumn } from '@/lib/salary/tax-column'

export interface EmployeeTaxValue {
  f_skatt_status: string
  is_sidoinkomst: boolean
  tax_table_number: number | null
  tax_column: number
  tax_municipality: string
}

interface EmployeeTaxCardProps {
  /** Live personnummer (full or masked): drives the column suggestion. */
  personnummer: string
  initial?: Partial<EmployeeTaxValue>
  /** Income year the table/column applies to. Defaults to the current year. */
  year?: number
  disabled?: boolean
  onChange: (value: EmployeeTaxValue) => void
}

function RequiredMark() {
  return <span className="text-destructive ml-0.5">*</span>
}

/**
 * The "Skatt" card on the employee form. Instead of asking the user to look up
 * an opaque skattetabell (29-42) and kolumn (1-6), it derives both from data we
 * already have: the folkbokföringskommun fills the tax table, and the
 * personnummer fills the column. Manual overrides remain for edge cases.
 */
export default function EmployeeTaxCard({
  personnummer,
  initial,
  year,
  disabled,
  onChange,
}: EmployeeTaxCardProps) {
  const incomeYear = year ?? new Date().getFullYear()

  const [fSkatt, setFSkatt] = useState(initial?.f_skatt_status ?? 'a_skatt')
  const [sido, setSido] = useState(initial?.is_sidoinkomst ?? false)
  const [municipality, setMunicipality] = useState(initial?.tax_municipality ?? '')
  const [tableNumber, setTableNumber] = useState<number | null>(initial?.tax_table_number ?? null)
  const [rate, setRate] = useState<number | null>(null)
  const [tableManual, setTableManual] = useState(false)
  const [column, setColumn] = useState(initial?.tax_column ?? 1)
  // Editing an existing employee: respect their saved column. New employee:
  // let the personnummer drive it until the user picks one.
  const [columnTouched, setColumnTouched] = useState(initial?.tax_column != null)

  const requiresTable = fSkatt === 'a_skatt' && !sido

  const derivedColumn = useMemo(
    () => deriveTaxColumn(personnummer, incomeYear),
    [personnummer, incomeYear]
  )
  const isSenior = personnummer.replace(/\D/g, '').length >= 8 && derivedColumn === null

  // The effective column is the user's explicit choice once they've made one,
  // otherwise the value suggested from the personnummer (falling back to 1).
  // Derived in render: no setState-in-effect needed.
  const effectiveColumn = columnTouched ? column : (derivedColumn ?? 1)

  // Report the current value up. onChange via ref so an unstable parent callback
  // doesn't retrigger the effect (deps are the primitive values only).
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })
  useEffect(() => {
    onChangeRef.current({
      f_skatt_status: fSkatt,
      is_sidoinkomst: sido,
      tax_table_number: requiresTable ? tableNumber : null,
      tax_column: effectiveColumn,
      tax_municipality: municipality.trim(),
    })
  }, [fSkatt, sido, tableNumber, effectiveColumn, municipality, requiresTable])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Skatt</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="f_skatt_status">
              <InfoTooltip content="A-skatt: du drar preliminärskatt enligt skattetabell. F-skatt/FA-skatt: personen sköter sin egen skatt: inget skatteavdrag görs.">
                Skatteform
              </InfoTooltip>
            </Label>
            <Select value={fSkatt} onValueChange={setFSkatt} disabled={disabled}>
              <SelectTrigger id="f_skatt_status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="a_skatt">A-skatt</SelectItem>
                <SelectItem value="f_skatt">F-skatt</SelectItem>
                <SelectItem value="fa_skatt">FA-skatt</SelectItem>
                <SelectItem value="not_verified">Ej verifierad</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sido}
                onChange={(e) => setSido(e.target.checked)}
                disabled={disabled}
                className="rounded border-border"
              />
              <InfoTooltip content="Kryssa i om detta INTE är personens huvudarbetsgivare. Då dras en fast skatt på 30 % istället för enligt tabell.">
                Sidoinkomst (30 % skatteavdrag)
              </InfoTooltip>
            </label>
          </div>
        </div>

        {requiresTable ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="tax_municipality">
                <InfoTooltip content="Kommunen där personen är folkbokförd (per 1 november föregående år). Den avgör skattetabellen: välj kommun så fylls tabellen i automatiskt.">
                  Folkbokföringskommun
                </InfoTooltip>
                <RequiredMark />
              </Label>
              <MunicipalityCombobox
                id="tax_municipality"
                value={municipality}
                year={incomeYear}
                disabled={disabled}
                onChange={(value) => {
                  setMunicipality(value)
                  // Clearing the field must clear the derived table/rate too:
                  // otherwise we'd report an empty kommun alongside a stale
                  // table number (an inconsistent pair). Manual entry keeps its
                  // own value.
                  if (!value && !tableManual) {
                    setTableNumber(null)
                    setRate(null)
                  }
                }}
                onSelect={(kommun, table, totalRate) => {
                  setMunicipality(kommun)
                  setRate(totalRate)
                  if (!tableManual) setTableNumber(table)
                }}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tax_table_number">
                  <InfoTooltip content="Skatteverkets tabell 29-42, baserad på kommunens totala skattesats. Härleds automatiskt från folkbokföringskommunen.">
                    Skattetabell
                  </InfoTooltip>
                  <RequiredMark />
                </Label>

                {tableManual ? (
                  <Input
                    id="tax_table_number"
                    type="number"
                    min="29"
                    max="42"
                    value={tableNumber ?? ''}
                    onChange={(e) => setTableNumber(parseInt(e.target.value) || null)}
                    disabled={disabled}
                  />
                ) : tableNumber ? (
                  <div className="flex items-baseline gap-2 rounded-md border border-input px-3 py-2">
                    <span className="font-sans text-xl tabular-nums">{tableNumber}</span>
                    {(municipality || rate != null) && (
                      <span className="text-xs text-muted-foreground">
                        {municipality}
                        {rate != null ? ` · ${rate.toLocaleString('sv-SE')} %` : ''}
                      </span>
                    )}
                  </div>
                ) : (
                  <p className="rounded-md border border-dashed border-input px-3 py-2 text-sm text-muted-foreground">
                    Välj kommun ovan
                  </p>
                )}

                {!disabled && (
                  <button
                    type="button"
                    onClick={() => setTableManual((v) => !v)}
                    className="text-xs text-primary hover:underline underline-offset-4"
                  >
                    {tableManual ? 'Använd kommunens tabell' : 'Ange tabell manuellt'}
                  </button>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="tax_column">
                  <InfoTooltip content="Kolumnen i skattetabellen avgör hur avdraget beräknas, främst utifrån ålder och inkomsttyp. Föreslås automatiskt från personnumret.">
                    Kolumn
                  </InfoTooltip>
                </Label>
                <Select
                  value={String(effectiveColumn)}
                  onValueChange={(v) => {
                    setColumn(parseInt(v))
                    setColumnTouched(true)
                  }}
                  disabled={disabled}
                >
                  <SelectTrigger id="tax_column">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TAX_COLUMN_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={String(opt.value)}>
                        {opt.value}. {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!columnTouched && derivedColumn != null ? (
                  <p className="text-xs text-muted-foreground">
                    Föreslås automatiskt: anställd under 66 år.
                  </p>
                ) : isSenior && !columnTouched ? (
                  <p className="text-xs text-warning-foreground">
                    Personen har fyllt 66 år: välj kolumn manuellt (lön = kolumn 3, pension = kolumn 2).
                  </p>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <p className="rounded-md border border-dashed border-input px-3 py-3 text-sm text-muted-foreground">
            {sido
              ? 'Sidoinkomst: ett fast skatteavdrag på 30 % görs: ingen skattetabell behövs.'
              : 'Med F-skatt eller FA-skatt sköter personen sin egen skatt: inget skatteavdrag görs och ingen skattetabell behövs.'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
