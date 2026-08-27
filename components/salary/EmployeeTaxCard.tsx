'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslations } from 'next-intl'
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
  /**
   * Jämkning (Skatteverket beslut om ändrad beräkning av skatteavdrag). All
   * three are null when there is no beslut; a null percentage clears it.
   */
  jamkning_percentage: number | null
  jamkning_valid_from: string | null
  jamkning_valid_to: string | null
}

interface EmployeeTaxCardProps {
  /** Live personnummer (full or masked): drives the column suggestion. */
  personnummer: string
  initial?: Partial<EmployeeTaxValue>
  /** Income year the table/column applies to. Defaults to the current year. */
  year?: number
  disabled?: boolean
  /**
   * Render the fields without the Card chrome (no border/header), for hosts
   * that lay their own section dividers around it (e.g. the compact
   * NewEmployeeDialog). The edit page keeps the default boxed rendering.
   */
  flat?: boolean
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
 * A jämkning beslut (fixed percentage with a validity period) can be entered
 * alongside the table: the engine uses the percentage while the beslut is
 * valid and falls back to the table outside that window.
 */
export default function EmployeeTaxCard({
  personnummer,
  initial,
  year,
  disabled,
  flat,
  onChange,
}: EmployeeTaxCardProps) {
  const t = useTranslations('salary_employee')
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
  // Jämkning is kept as raw input strings so a half-typed value ("12.") does
  // not snap; the parsed number is derived below. Not rounded: decimals like
  // 12.5 are legal (the API caps at 0..100).
  const [jamkningPct, setJamkningPct] = useState(
    initial?.jamkning_percentage != null ? String(initial.jamkning_percentage) : ''
  )
  const [jamkningFrom, setJamkningFrom] = useState(initial?.jamkning_valid_from ?? '')
  const [jamkningTo, setJamkningTo] = useState(initial?.jamkning_valid_to ?? '')

  const requiresTable = fSkatt === 'a_skatt' && !sido

  const jamkningValue = (() => {
    const n = parseFloat(jamkningPct)
    return Number.isFinite(n) ? n : null
  })()
  // Jämkning only reaches the engine for A-skatt without sidoinkomst, so like
  // tax_table_number it is reported as null (= clear the beslut) otherwise.
  const hasJamkning = requiresTable && jamkningValue !== null

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
      jamkning_percentage: hasJamkning ? jamkningValue : null,
      jamkning_valid_from: hasJamkning ? jamkningFrom || null : null,
      jamkning_valid_to: hasJamkning ? jamkningTo || null : null,
    })
  }, [
    fSkatt,
    sido,
    tableNumber,
    effectiveColumn,
    municipality,
    requiresTable,
    hasJamkning,
    jamkningValue,
    jamkningFrom,
    jamkningTo,
  ])

  const body = (
    <>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="f_skatt_status">
              <InfoTooltip content={t('tax_form_tooltip')}>
                {t('tax_form_label')}
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
                <SelectItem value="not_verified">{t('tax_status_not_verified')}</SelectItem>
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
                className="rounded-sm border-border"
              />
              <InfoTooltip content={t('tax_sidoinkomst_tooltip')}>
                {t('tax_sidoinkomst_label')}
              </InfoTooltip>
            </label>
          </div>
        </div>

        {requiresTable ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="tax_municipality">
                <InfoTooltip content={t('tax_municipality_tooltip')}>
                  {t('tax_municipality_label')}
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
                  <InfoTooltip content={t('tax_table_tooltip')}>
                    {t('tax_table_label')}
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
                  <div className="flex items-baseline gap-2 rounded-lg border border-input px-3 py-2">
                    <span className="font-sans text-xl tabular-nums">{tableNumber}</span>
                    {(municipality || rate != null) && (
                      <span className="text-xs text-muted-foreground">
                        {municipality}
                        {rate != null ? ` · ${rate.toLocaleString('sv-SE')} %` : ''}
                      </span>
                    )}
                  </div>
                ) : (
                  <p className="rounded-lg border border-dashed border-input px-3 py-2 text-sm text-muted-foreground">
                    {t('tax_table_pick_municipality')}
                  </p>
                )}

                {!disabled && (
                  <button
                    type="button"
                    onClick={() => setTableManual((v) => !v)}
                    className="text-xs text-primary hover:underline underline-offset-4"
                  >
                    {tableManual ? t('tax_table_use_municipality') : t('tax_table_enter_manually')}
                  </button>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="tax_column">
                  <InfoTooltip content={t('tax_column_tooltip')}>
                    {t('tax_column_label')}
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
                    {t('tax_column_suggested_under_66')}
                  </p>
                ) : isSenior && !columnTouched ? (
                  <p className="text-xs text-attn">
                    {t('tax_column_senior_warning')}
                  </p>
                ) : null}
              </div>
            </div>

            {/* Jämkning: a Skatteverket beslut overrides the table with a fixed
                percentage for a bounded period. The engine only applies it when
                BOTH dates are set, so both are required as soon as a percentage
                is entered (native `required`: both hosts render this inside a
                <form>). The table fields stay visible above: they apply again
                once the beslut expires. */}
            <div className="space-y-2">
              <Label htmlFor="jamkning_percentage">
                <InfoTooltip content={t('tax_jamkning_tooltip')}>
                  {t('tax_jamkning_label')}
                </InfoTooltip>
              </Label>
              <Input
                id="jamkning_percentage"
                type="number"
                min="0"
                max="100"
                step="any"
                inputMode="decimal"
                value={jamkningPct}
                onChange={(e) => setJamkningPct(e.target.value)}
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">{t('tax_jamkning_hint')}</p>
            </div>

            {jamkningValue !== null && (
              <div className="space-y-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="jamkning_valid_from">
                      {t('tax_jamkning_valid_from')}
                      <RequiredMark />
                    </Label>
                    <Input
                      id="jamkning_valid_from"
                      type="date"
                      value={jamkningFrom}
                      onChange={(e) => setJamkningFrom(e.target.value)}
                      required
                      disabled={disabled}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="jamkning_valid_to">
                      {t('tax_jamkning_valid_to')}
                      <RequiredMark />
                    </Label>
                    <Input
                      id="jamkning_valid_to"
                      type="date"
                      value={jamkningTo}
                      min={jamkningFrom || undefined}
                      onChange={(e) => setJamkningTo(e.target.value)}
                      required
                      disabled={disabled}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{t('tax_jamkning_dates_hint')}</p>
              </div>
            )}
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-input px-3 py-3 text-sm text-muted-foreground">
            {sido
              ? t('tax_no_table_sidoinkomst')
              : t('tax_no_table_f_skatt')}
          </p>
        )}
    </>
  )

  if (flat) {
    return <div className="space-y-4">{body}</div>
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('tax_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">{body}</CardContent>
    </Card>
  )
}
