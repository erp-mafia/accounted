'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, Info, Pencil, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { HelpPopover } from '@/components/ui/help-popover'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AccountNumber } from '@/components/ui/account-number'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { formatWholeKronor } from '@/components/reports/DeclarationRutaRow'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatOrgNumber } from '@/lib/utils'
import { ink3Sections, ink3SignMark } from '@/lib/reports/ink3/presentation'
import type {
  Ink3Field,
  Ink3FieldValue,
  Ink3Inputs,
  Ink3Treatment,
  Ink3Underlag,
} from '@/lib/reports/ink3/types'

/**
 * The INK3 underlag for an ideell förening (#47): what goes in each ruta of
 * INK3R, INK3S and INK3SUF, the per-account treatment that builds the taxable
 * column, the allmännyttig statement, and an override per ruta. Nothing is
 * filed from here: the user types the figures into Skatteverket's e-tjänst
 * and signs the first page there. Ruta labels are Skatteverket's and stay
 * Swedish in both locales.
 */

const FORENING_GUIDE_URL =
  'https://skatteverket.se/foreningar/deklarera/deklareraforideellforeningellerstiftelse.4.1927c51b15e7ee438721ff8.html'

/** What the screen edits: amounts as typed text until saved. */
interface Draft {
  allmannyttig: boolean | null
  treatments: Record<string, Ink3Treatment>
  values: Record<string, string | boolean>
}

type Statement = 'yes' | 'no' | 'unset'

function draftFromInputs(inputs: Ink3Inputs): Draft {
  const values: Record<string, string | boolean> = {}
  for (const [code, value] of Object.entries(inputs.fieldOverrides)) {
    values[code] = typeof value === 'number' ? String(value) : value
  }
  return { allmannyttig: inputs.allmannyttig, treatments: { ...inputs.accountTreatments }, values }
}

/** Whole kronor typed by a person: spaces allowed, no öre. */
function parseWholeKronor(text: string): number | null {
  const compact = text.replace(/[\s ]/g, '').replace(/^−/, '-')
  return /^-?\d{1,12}$/.test(compact) ? Number(compact) : null
}

/** The draft as the API body; null with the codes that do not parse. */
function toBody(draft: Draft, fieldsByCode: ReadonlyMap<string, Ink3Field>) {
  const overrides: Record<string, Ink3FieldValue> = {}
  const invalid: string[] = []
  for (const [code, value] of Object.entries(draft.values)) {
    const field = fieldsByCode.get(code)
    if (!field) continue
    if (field.datatyp === 'Str_X') {
      if (value === true) overrides[code] = true
    } else if (field.datatyp === 'Str_36') {
      if (typeof value === 'string' && value.trim() !== '') overrides[code] = value.trim()
    } else if (typeof value === 'string' && value.trim() !== '') {
      const amount = parseWholeKronor(value)
      if (amount === null) invalid.push(code)
      else overrides[code] = amount
    }
  }
  return {
    invalid,
    body: {
      allmannyttig: draft.allmannyttig,
      account_treatments: draft.treatments,
      field_overrides: overrides,
    },
  }
}

function statementOf(value: boolean | null): Statement {
  return value === null ? 'unset' : value ? 'yes' : 'no'
}

function amountText(value: Ink3FieldValue | null): string {
  return typeof value === 'number' ? formatWholeKronor(value) : ''
}

export function INK3UnderlagView({ periodId }: { periodId: string }) {
  const t = useTranslations('ink3_underlag')
  const errorLocale = useLocale() as ErrorLocale
  const [result, setResult] = useState<{ key: string; data?: Ink3Underlag; error?: string } | null>(null)
  const [saved, setSaved] = useState<Ink3Inputs | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [invalidCodes, setInvalidCodes] = useState<string[]>([])

  const fetchKey = `${periodId}:${retryKey}`

  useEffect(() => {
    let cancelled = false
    const query = `period_id=${encodeURIComponent(periodId)}`
    Promise.all([fetch(`/api/reports/ink3?${query}`), fetch(`/api/reports/ink3/inputs?${query}`)])
      .then(async ([underlagRes, inputsRes]) => {
        const underlag = await underlagRes.json().catch(() => null)
        const inputs = await inputsRes.json().catch(() => null)
        if (cancelled) return
        if (!underlagRes.ok || underlag?.error || !inputsRes.ok || !inputs?.data) {
          const failed = !underlagRes.ok || underlag?.error ? underlag : inputs
          setResult({ key: fetchKey, error: getErrorMessage(failed, { locale: errorLocale, fallback: t('load_failed') }) })
          return
        }
        setSaved(inputs.data)
        setDraft(draftFromInputs(inputs.data))
        setResult({ key: fetchKey, data: underlag.data })
      })
      .catch(() => {
        if (!cancelled) setResult({ key: fetchKey, error: t('load_failed') })
      })
    return () => {
      cancelled = true
    }
  }, [fetchKey, periodId, errorLocale, t])

  const upToDate = result !== null && result.key === fetchKey
  const data = result?.data ?? null
  const error = upToDate ? (result.error ?? null) : null
  const loading = !upToDate

  const fieldsByCode = useMemo(() => new Map((data?.fields ?? []).map((f) => [f.code, f])), [data])
  const sections = useMemo(() => (data ? ink3Sections(data.fields) : null), [data])
  const dirty = useMemo(
    () => draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(draftFromInputs(saved)),
    [draft, saved],
  )

  const setValue = (code: string, value: string | boolean | undefined) => {
    setDraft((current) => {
      if (!current) return current
      const values = { ...current.values }
      if (value === undefined) delete values[code]
      else values[code] = value
      return { ...current, values }
    })
  }

  const setTreatment = (account: string, treatment: Ink3Treatment | null) => {
    setDraft((current) => {
      if (!current) return current
      const treatments = { ...current.treatments }
      if (treatment === null) delete treatments[account]
      else treatments[account] = treatment
      return { ...current, treatments }
    })
  }

  const save = async () => {
    if (!draft) return
    const { invalid, body } = toBody(draft, fieldsByCode)
    setInvalidCodes(invalid)
    if (invalid.length > 0) {
      setSaveError(t('invalid_amount'))
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/reports/ink3/inputs?period_id=${encodeURIComponent(periodId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.error) {
        setSaveError(getErrorMessage(json, { locale: errorLocale, fallback: t('save_failed') }))
        return
      }
      setSaved(json.data)
      setDraft(draftFromInputs(json.data))
      setRetryKey((k) => k + 1)
    } catch {
      setSaveError(t('save_failed'))
    } finally {
      setSaving(false)
    }
  }

  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-3 py-4 text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span className="text-sm">{error}</span>
        <Button variant="outline" onClick={() => setRetryKey((k) => k + 1)}>
          {t('retry')}
        </Button>
      </div>
    )
  }

  if (!data || !sections || !draft) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  const valueCell = (field: Ink3Field | null) =>
    field ? (
      <ValueCell
        field={field}
        draftValue={draft.values[field.code]}
        invalid={invalidCodes.includes(field.code)}
        onChange={(value) => setValue(field.code, value)}
      />
    ) : null

  return (
    <div className={`space-y-8 transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`}>
      <ReportExportMenu
        items={[{ format: 'pdf', href: `/api/reports/ink3?period_id=${encodeURIComponent(periodId)}&format=pdf` }]}
      >
        {dirty && (
          <>
            <Button variant="outline" size="sm" onClick={() => saved && setDraft(draftFromInputs(saved))} disabled={saving}>
              {t('discard')}
            </Button>
            <Button size="sm" onClick={save} loading={saving}>
              {t('save')}
            </Button>
          </>
        )}
      </ReportExportMenu>

      <div className="space-y-3 px-1">
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground">
            {t('period_line', {
              company: data.companyInfo.companyName,
              year: data.fiscalYear.name,
              period: data.beskattningsperiod,
            })}
            {data.companyInfo.orgNumber && ` · ${t('org_number', { orgNumber: formatOrgNumber(data.companyInfo.orgNumber) })}`}
          </p>
          <HelpPopover>{t('help')}</HelpPopover>
        </div>
        <div className="flex items-start gap-2">
          <Info className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-[13px] leading-6 text-muted-foreground">
            {t('filing_note')}{' '}
            <a
              href={FORENING_GUIDE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 text-foreground"
            >
              {t('how_to_file')}
            </a>
          </p>
        </div>
        {saveError && (
          <div role="alert" className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-1 h-4 w-4 shrink-0" />
            {saveError}
          </div>
        )}
      </div>

      <section className="space-y-2 px-1">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px]">{t('allmannyttig_label')}</span>
          <SegmentedControl<Statement>
            aria-label={t('allmannyttig_label')}
            value={statementOf(draft.allmannyttig)}
            onChange={(value) =>
              setDraft({ ...draft, allmannyttig: value === 'unset' ? null : value === 'yes' })
            }
            options={[
              { value: 'yes', label: t('allmannyttig_yes') },
              { value: 'no', label: t('allmannyttig_no') },
              { value: 'unset', label: t('allmannyttig_unset') },
            ]}
          />
        </div>
        <p className="text-[12.5px] leading-5 text-muted-foreground">{t('allmannyttig_note')}</p>
      </section>

      {data.warnings.length > 0 && (
        <div className="flex items-start gap-2 px-1">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-attn" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-[12.5px] font-medium leading-5 text-attn">
              {t('warnings_count', { count: data.warnings.length })}
            </p>
            {data.warnings.map((warning, i) => (
              <p key={i} className="text-[12.5px] leading-5 text-muted-foreground">
                {warning}
              </p>
            ))}
          </div>
        </div>
      )}

      <Section title={t('accounts_heading')}>
        <p className="mb-3 text-[12.5px] leading-5 text-muted-foreground">{t('accounts_note')}</p>
        {data.accounts.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('accounts_empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-0">{t('col_account')}</TableHead>
                <TableHead className="px-0">{t('col_ruta')}</TableHead>
                <TableHead className="px-0 text-right">{t('col_amount')}</TableHead>
                <TableHead className="px-0 text-right">{t('col_treatment')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.accounts.map((account) => (
                <TableRow key={account.accountNumber}>
                  <TableCell className="px-0 py-2">
                    <AccountNumber number={account.accountNumber} name={account.accountName} size="sm" />
                    <span className="ml-2">{account.accountName}</span>
                  </TableCell>
                  <TableCell className="px-0 py-2 font-mono text-xs text-muted-foreground">{account.ruta}</TableCell>
                  <TableCell className="px-0 py-2 text-right tabular-nums">{formatWholeKronor(account.amount)}</TableCell>
                  <TableCell className="px-0 py-2 text-right">
                    <Select
                      value={draft.treatments[account.accountNumber] ?? 'unset'}
                      onValueChange={(value) =>
                        setTreatment(account.accountNumber, value === 'unset' ? null : (value as Ink3Treatment))
                      }
                    >
                      <SelectTrigger className="ml-auto h-8 w-40" aria-label={`${t('col_treatment')} ${account.accountNumber}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="taxable">{t('treatment_taxable')}</SelectItem>
                        <SelectItem value="exempt">{t('treatment_exempt')}</SelectItem>
                        <SelectItem value="shared">{t('treatment_shared')}</SelectItem>
                        <SelectItem value="unset">{t('treatment_unset')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title={t('section_assets')}>
        <FieldTable fields={sections.assets} valueCell={valueCell} total={{ label: t('total_assets'), amount: data.totals.totalAssets }} />
      </Section>

      <Section title={t('section_equity')}>
        <FieldTable
          fields={sections.equityLiabilities}
          valueCell={valueCell}
          total={{ label: t('total_equity'), amount: data.totals.totalEquityLiabilities }}
        />
      </Section>

      <Section title={t('section_income')}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14 px-0">{t('col_ruta')}</TableHead>
              <TableHead className="px-0">{t('col_post')}</TableHead>
              <TableHead className="px-0 text-right">{t('col_bokforing')}</TableHead>
              <TableHead className="px-0 text-right">{t('col_skattepliktig')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sections.incomeStatement.map((row) => (
              <TableRow key={row.key}>
                <TableCell className="px-0 py-2 font-mono text-xs text-muted-foreground">{row.ruta}</TableCell>
                <TableCell className="px-0 py-2">
                  <span className="mr-1 font-mono text-xs text-muted-foreground">{row.sign}</span>
                  {row.label}
                  <AccountsToggle ruta={row.ruta} field={row.bokforing} />
                </TableCell>
                <TableCell className="px-0 py-2 text-right">{valueCell(row.bokforing)}</TableCell>
                <TableCell className="px-0 py-2 text-right">{valueCell(row.skattepliktig)}</TableCell>
              </TableRow>
            ))}
            {sections.results.map((field) => (
              <TableRow key={field.code} className="font-medium">
                <TableCell className="px-0 py-2 font-mono text-xs text-muted-foreground">{field.ruta}</TableCell>
                <TableCell className="px-0 py-2">{field.label}</TableCell>
                <TableCell className="px-0 py-2 text-right tabular-nums">
                  {field.column === 'bokforing' ? amountText(field.value) : ''}
                </TableCell>
                <TableCell className="px-0 py-2 text-right tabular-nums">
                  {field.column === 'skattepliktig' ? amountText(field.value) : ''}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title={t('section_ink3s')}>
        <FieldTable fields={sections.ink3s} valueCell={valueCell} />
      </Section>

      <Section title={t('section_suf')}>
        {draft.allmannyttig !== true ? (
          <p className="text-[13px] text-muted-foreground">{t('suf_not_applicable')}</p>
        ) : (
          <div className="space-y-6">
            <div>
              <h4 className="mb-2 text-[13px] font-medium">{t('suf_purposes')}</h4>
              <div className="grid gap-2 sm:grid-cols-2">
                {sections.sufPurposes.map((field) =>
                  field.datatyp === 'Str_X' ? (
                    <label key={field.code} className="flex items-center gap-2 text-[13px]">
                      <Checkbox
                        checked={draft.values[field.code] === true}
                        onCheckedChange={(checked) => setValue(field.code, checked === true ? true : undefined)}
                      />
                      {field.label}
                    </label>
                  ) : (
                    <label key={field.code} className="flex items-center gap-2 text-[13px] sm:col-span-2">
                      <span className="shrink-0">{field.label}</span>
                      <Input
                        value={typeof draft.values[field.code] === 'string' ? (draft.values[field.code] as string) : ''}
                        maxLength={36}
                        onChange={(e) => setValue(field.code, e.target.value === '' ? undefined : e.target.value)}
                      />
                    </label>
                  ),
                )}
              </div>
            </div>
            <div>
              <h4 className="mb-2 text-[13px] font-medium">{t('suf_property')}</h4>
              <Table>
                <TableBody>
                  {sections.sufProperty.map((field) => (
                    <TableRow key={field.code}>
                      <TableCell className="px-0 py-2">
                        {field.datatyp === 'Numeriskt_N' ? t('suf_area_percent') : t('suf_area_sqm')}
                      </TableCell>
                      <TableCell className="w-24 px-0 py-2 text-right font-mono text-xs text-muted-foreground">{field.code}</TableCell>
                      <TableCell className="px-0 py-2 text-right">{valueCell(field)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div>
              <h4 className="mb-2 text-[13px] font-medium">{t('suf_amounts')}</h4>
              <FieldTable fields={sections.sufAmounts} valueCell={valueCell} />
            </div>
          </div>
        )}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2 px-1">
        <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
        <div className="h-px flex-1 bg-border" />
      </div>
      <div className="px-1 pt-2">{children}</div>
    </section>
  )
}

function FieldTable({
  fields,
  valueCell,
  total,
}: {
  fields: Ink3Field[]
  valueCell: (field: Ink3Field) => React.ReactNode
  total?: { label: string; amount: number }
}) {
  const t = useTranslations('ink3_underlag')
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-14 px-0">{t('col_ruta')}</TableHead>
          <TableHead className="px-0">{t('col_post')}</TableHead>
          <TableHead className="w-20 px-0 text-right">{t('col_code')}</TableHead>
          <TableHead className="px-0 text-right">{t('col_amount')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {fields.map((field) => (
          <TableRow key={field.code}>
            <TableCell className="px-0 py-2 font-mono text-xs text-muted-foreground">{field.ruta ?? ''}</TableCell>
            <TableCell className="px-0 py-2">
              {ink3SignMark(field) && <span className="mr-1 font-mono text-xs text-muted-foreground">{ink3SignMark(field)}</span>}
              {field.label}
              <AccountsToggle ruta={field.ruta ?? field.code} field={field} />
            </TableCell>
            <TableCell className="px-0 py-2 text-right font-mono text-xs text-muted-foreground">{field.code}</TableCell>
            <TableCell className="px-0 py-2 text-right">{valueCell(field)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      {total && (
        <tfoot>
          <tr className="border-t font-medium">
            <td className="py-2" colSpan={3}>
              {total.label}
            </td>
            <td className="py-2 text-right tabular-nums">{formatWholeKronor(total.amount)}</td>
          </tr>
        </tfoot>
      )}
    </Table>
  )
}

/** The accounts behind a books ruta, behind a keyboard-reachable toggle. */
function AccountsToggle({ ruta, field }: { ruta: string; field: Ink3Field | null }) {
  const t = useTranslations('ink3_underlag')
  const [open, setOpen] = useState(false)
  if (!field || field.accounts.length === 0) return null
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t('hide_accounts', { ruta }) : t('show_accounts', { ruta })}
        onClick={() => setOpen((v) => !v)}
        className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-sm align-middle text-muted-foreground hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {open && (
        <span className="mt-1 block space-y-0.5 pl-4 text-xs text-muted-foreground">
          {field.accounts.map((account) => (
            <span key={account.accountNumber} className="flex justify-between gap-4">
              <span>
                {account.accountNumber} {account.accountName}
              </span>
              <span className="tabular-nums">{formatWholeKronor(account.amount)}</span>
            </span>
          ))}
        </span>
      )}
    </>
  )
}

/**
 * One ruta's value: a sum as plain text; an input field (INK3S, INK3SUF) as
 * an input; a books or computed figure as text with a pencil to override it,
 * and the override with a reset back to the computed figure.
 */
function ValueCell({
  field,
  draftValue,
  invalid,
  onChange,
}: {
  field: Ink3Field
  draftValue: string | boolean | undefined
  invalid: boolean
  onChange: (value: string | boolean | undefined) => void
}) {
  const t = useTranslations('ink3_underlag')
  const label = field.ruta ?? field.code

  if (!field.overridable) {
    return <span className="tabular-nums">{amountText(field.value)}</span>
  }

  if (field.datatyp === 'Str_X') {
    return (
      <Checkbox
        aria-label={field.label}
        checked={draftValue === true}
        onCheckedChange={(checked) => onChange(checked === true ? true : undefined)}
      />
    )
  }

  const input = (
    <Input
      value={typeof draftValue === 'string' ? draftValue : ''}
      inputMode="numeric"
      aria-label={t('edit_amount', { ruta: label })}
      aria-invalid={invalid || undefined}
      className={`ml-auto h-8 w-36 text-right tabular-nums ${invalid ? 'border-destructive' : ''}`}
      onChange={(e) => onChange(e.target.value === '' && field.source === 'input' ? undefined : e.target.value)}
    />
  )

  if (field.source === 'input') return input

  if (draftValue !== undefined) {
    return (
      <span className="inline-flex items-center justify-end gap-1">
        <Badge variant="outline">{t('overridden')}</Badge>
        {input}
        <Button variant="ghost" size="icon-sm" aria-label={t('reset_amount', { ruta: label })} onClick={() => onChange(undefined)}>
          <RotateCcw className="h-4 w-4" />
        </Button>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center justify-end gap-1">
      {field.needsInput && <Badge variant="warning">{t('needs_input')}</Badge>}
      <span className="tabular-nums">{amountText(field.value)}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('edit_amount', { ruta: label })}
        onClick={() => onChange(String(field.computed ?? 0))}
      >
        <Pencil className="h-4 w-4" />
      </Button>
    </span>
  )
}

