'use client'

import { useTranslations } from 'next-intl'
import { useState, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Trash2, Plus } from 'lucide-react'
import { TEMPLATE_CATEGORY_LABELS, convertLibraryToBookingTemplate, applyTemplate } from '@/lib/bookkeeping/template-library'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { formatCurrency } from '@/lib/utils'
import type { BookingTemplateLibrary, BookingTemplateCategory, BookingTemplateLibraryLine } from '@/types'

export type TemplateFormMode = 'create' | 'edit' | 'duplicate'

/**
 * Shared editor for booking templates. Seeds its state once from
 * `initialTemplate` (used by the settings panel to edit/customize a template,
 * and by "Spara som mall" in the booking dialog to pre-fill a derived draft).
 *
 * Submit behaviour is driven by `mode`: 'edit' PUTs the existing template,
 * 'create' and 'duplicate' both POST a new company-scoped template.
 */
export function TemplateForm({
  mode,
  initialTemplate,
  entityLabels,
  duplicateNamePool = [],
  onSaved,
}: {
  mode: TemplateFormMode
  initialTemplate?: BookingTemplateLibrary
  entityLabels: Record<string, string>
  duplicateNamePool?: string[]
  onSaved: () => void
}) {
  const t = useTranslations('settings_booking_templates')
  const { toast } = useToast()
  const [isSubmitting, setIsSubmitting] = useState(false)
  // When customizing a system template (mode 'duplicate') we suggest a distinct
  // "(anpassad)" name so the company copy doesn't read as the standard one.
  const [name, setName] = useState(() =>
    initialTemplate
      ? mode === 'duplicate'
        ? t('copy_name_suffix', { name: initialTemplate.name })
        : initialTemplate.name
      : '',
  )
  const [description, setDescription] = useState(initialTemplate?.description ?? '')
  const [category, setCategory] = useState<BookingTemplateCategory>(initialTemplate?.category ?? 'other')
  const [entityType, setEntityType] = useState<'all' | 'enskild_firma' | 'aktiebolag'>(
    initialTemplate?.entity_type ?? 'all',
  )
  const [lines, setLines] = useState<BookingTemplateLibraryLine[]>(() =>
    initialTemplate
      ? initialTemplate.lines.map((l) => ({ ...l }))
      : [
          { account: '', label: '', side: 'debit', type: 'business', ratio: 1 },
          { account: '', label: '', side: 'credit', type: 'settlement', ratio: 1 },
        ],
  )

  function updateLine(index: number, field: keyof BookingTemplateLibraryLine, value: string | number) {
    setLines((prev) => {
      const updated = [...prev]
      updated[index] = { ...updated[index], [field]: value }
      return updated
    })
  }

  function updateLineType(index: number, newType: BookingTemplateLibraryLine['type']) {
    setLines((prev) => {
      const updated = [...prev]
      const current = updated[index]
      const next: BookingTemplateLibraryLine = { ...current, type: newType }
      // Auto-pick a sensible default for the type-specific field so the
      // converter (and applyTemplate) sees a complete line shape.
      if (newType === 'vat' && next.vat_rate === undefined) {
        next.vat_rate = 0.25
      }
      updated[index] = next
      return updated
    })
  }

  // Default new lines to a VAT line — the 2-line template starts with one
  // business + one settlement, and the natural extension is a VAT leg.
  // Defaulting to 'business' instead would silently break the converter
  // (which requires exactly one business line) and the template would
  // disappear from the transaction picker.
  function addLine() {
    setLines((prev) => [...prev, { account: '', label: '', side: 'debit', type: 'vat', vat_rate: 0.25 }])
  }

  function removeLine(index: number) {
    if (lines.length <= 2) return
    setLines((prev) => prev.filter((_, i) => i !== index))
  }

  // Ratio is only load-bearing when a template splits the amount across more
  // than one cost/revenue line. Hide it for the simple case to keep the form
  // approachable for non-accountants; it stays 1.0 under the hood.
  const businessLineCount = lines.filter((l) => l.type === 'business').length
  const showRatio = businessLineCount > 1
  // The ratio only validates against cost/revenue lines (businessRatioSum), so
  // only those get an editable input. The settlement leg is the full counter-
  // amount (ratio 1.0) and is shown in the live preview, not as a control —
  // an editable settlement ratio that doesn't feed the sum check would mislead.
  const firstRatioIndex = showRatio ? lines.findIndex((l) => l.type === 'business') : -1
  const businessRatioSum = lines
    .filter((l) => l.type === 'business')
    .reduce((sum, l) => sum + (l.ratio ?? 1), 0)
  const ratioSumOff = showRatio && Math.abs(businessRatioSum - 1) > 0.001

  // Live split preview for a 1 000 kr amount. Computed only once every line has
  // an account so the table doesn't flicker while the form is half-filled.
  const preview = useMemo(() => {
    if (lines.some((l) => !l.account)) return null
    try {
      return applyTemplate(lines, 1000)
    } catch {
      return null
    }
  }, [lines])

  // Soft, non-blocking hint when the chosen name collides with an existing
  // company template (no DB unique constraint — duplicates are allowed).
  const nameCollision =
    mode !== 'edit' &&
    name.trim().length > 0 &&
    duplicateNamePool.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase())

  // Real-time check: can this draft be picked from the transaction sheet?
  // If not, we show a hint — save remains allowed (templates may still be
  // useful from the journal-entry form).
  const isConvertible = (() => {
    const draft: BookingTemplateLibrary = {
      id: initialTemplate?.id ?? '',
      company_id: null,
      team_id: null,
      created_by: null,
      name,
      description,
      category,
      entity_type: entityType,
      lines,
      is_system: false,
      is_active: true,
      created_at: '',
      updated_at: '',
    }
    return convertLibraryToBookingTemplate(draft) !== null
  })()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name || lines.some((l) => !l.account || !l.label)) {
      toast({ title: t('toast_fill_all_fields'), variant: 'destructive' })
      return
    }

    setIsSubmitting(true)
    try {
      // Edit updates the existing template in place (PUT); create and duplicate
      // both write a new company-scoped template (POST).
      const isEdit = mode === 'edit'
      const url = isEdit
        ? `/api/settings/booking-templates/${initialTemplate!.id}`
        : '/api/settings/booking-templates'
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, category, entity_type: entityType, lines }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        toast({ title: json.error || t('toast_create_failed'), variant: 'destructive' })
        return
      }
      toast({ title: isEdit ? t('toast_updated') : t('toast_created') })
      onSaved()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label>{t('name_label')}</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('name_placeholder')}
          autoFocus={mode === 'duplicate'}
          onFocus={mode === 'duplicate' ? (e) => e.target.select() : undefined}
        />
      </div>
      <div>
        <Label>{t('description_label')} <span className="text-muted-foreground font-normal">{t('optional_suffix')}</span></Label>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('description_placeholder')} rows={2} className="resize-none" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>{t('category_label')}</Label>
          <Select value={category} onValueChange={(v) => setCategory(v as BookingTemplateCategory)}>
            <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(TEMPLATE_CATEGORY_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>{t('entity_type_label')}</Label>
          <Select value={entityType} onValueChange={(v) => setEntityType(v as typeof entityType)}>
            <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(entityLabels).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <Label>{t('lines_label')}</Label>
        <div className="space-y-2 mt-1">
          {lines.map((line, i) => {
            const showRatioInput = showRatio && line.type === 'business'
            return (
            <div key={i} className="rounded-md border border-border p-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <Input
                  value={line.account}
                  onChange={(e) => updateLine(i, 'account', e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder={t('account_placeholder')}
                  className="w-20 font-mono"
                  maxLength={4}
                />
                <Input
                  value={line.label}
                  onChange={(e) => updateLine(i, 'label', e.target.value)}
                  placeholder={t('description_short_placeholder')}
                  className="flex-1 min-w-0"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeLine(i)}
                  disabled={lines.length <= 2}
                  className="h-8 w-8 p-0 shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Select value={line.side} onValueChange={(v) => updateLine(i, 'side', v)}>
                  <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="debit">{t('debit_label')}</SelectItem>
                    <SelectItem value="credit">{t('credit_label')}</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={line.type} onValueChange={(v) => updateLineType(i, v as BookingTemplateLibraryLine['type'])}>
                  <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="business">{t('type_cost')}</SelectItem>
                    <SelectItem value="vat">{t('type_vat')}</SelectItem>
                    <SelectItem value="settlement">{t('type_settlement')}</SelectItem>
                  </SelectContent>
                </Select>
                {line.type === 'vat' && (
                  <Select
                    value={String(line.vat_rate ?? 0.25)}
                    onValueChange={(v) => updateLine(i, 'vat_rate', Number(v))}
                  >
                    <SelectTrigger className="w-24" aria-label={t('vat_rate_label')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0.25">{t('vat_rate_25')}</SelectItem>
                      <SelectItem value="0.12">{t('vat_rate_12')}</SelectItem>
                      <SelectItem value="0.06">{t('vat_rate_6')}</SelectItem>
                      <SelectItem value="0">{t('vat_rate_0')}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                {showRatioInput && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Input
                      type="number"
                      inputMode="decimal"
                      step="0.1"
                      min={0}
                      max={10}
                      value={String(line.ratio ?? 1)}
                      onChange={(e) => {
                        const n = Number(e.target.value)
                        if (!Number.isNaN(n)) updateLine(i, 'ratio', n)
                      }}
                      aria-label={t('ratio_label')}
                      className="w-16 font-mono tabular-nums text-right"
                    />
                    {i === firstRatioIndex && <InfoTooltip content={t('ratio_help')} />}
                  </div>
                )}
              </div>
            </div>
          )})}
          <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <Plus className="h-3 w-3 mr-1" />
            {t('add_line')}
          </Button>
        </div>
      </div>

      {ratioSumOff && (
        <div className="rounded-lg border border-warning/30 bg-warning/[0.03] px-3 py-2">
          <p className="text-xs text-warning-foreground leading-snug">
            {t('ratio_sum_warning')}
          </p>
        </div>
      )}

      {preview && (
        <div>
          <Label>{t('preview_label')}</Label>
          <table className="w-full text-xs mt-1">
            <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
              <tr className="border-b">
                <th className="text-left py-1 w-14">{t('th_account')}</th>
                <th className="text-left py-1">{t('th_description')}</th>
                <th className="text-right py-1 w-20">{t('th_debit')}</th>
                <th className="text-right py-1 w-20">{t('th_credit')}</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((pl, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-1 font-mono">{pl.account_number}</td>
                  <td className="py-1">{pl.line_description}</td>
                  <td className="py-1 text-right tabular-nums">
                    {pl.debit_amount ? formatCurrency(Number(pl.debit_amount)) : ''}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {pl.credit_amount ? formatCurrency(Number(pl.credit_amount)) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nameCollision && (
        <div className="rounded-lg border border-warning/30 bg-warning/[0.03] px-3 py-2">
          <p className="text-xs text-warning-foreground leading-snug">
            {t('duplicate_name_warning')}
          </p>
        </div>
      )}

      {!isConvertible && (
        <div className="rounded-lg border border-warning/30 bg-warning/[0.03] px-3 py-2">
          <p className="text-xs text-warning-foreground leading-snug">
            {t('unconvertible_hint')}
          </p>
        </div>
      )}

      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        {mode === 'create' ? t('create_button') : t('save_button')}
      </Button>
    </form>
  )
}
