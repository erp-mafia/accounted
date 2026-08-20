'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DetailSection } from '@/components/ui/detail-section'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  SettingsInput,
  SettingsRow,
  SettingsRowNote,
  SettingsTextarea,
} from '@/components/settings/SettingsRows'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency } from '@/lib/utils'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

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

// Amount fields are sized by their content, not by the row. ph-no-capture:
// the placeholder is the employee's effective amount, and replay masking
// covers values, not attributes.
const FIELD_CLASS = 'max-w-44 flex-none tabular-nums ph-no-capture'

function num(v: string): number | null {
  const trimmed = v.trim()
  if (!trimmed) return null
  const n = Number(trimmed.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

export function SalaryOverridePanel(props: SalaryOverridePanelProps) {
  const t = useTranslations('salary_override')
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
      // Skatteavdrag is stated in whole kronor (öretal bortfaller): the
      // schema rejects öre, so drop them here instead of bouncing the save
      // with a 400 when someone types a decimal.
      const taxOverride = num(taxStr)
      const body = {
        tax_withheld_override: taxOverride === null ? null : Math.trunc(taxOverride),
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
          title: t('save_failed'),
          description: typeof data?.error === 'string' ? data.error : t('unknown_error'),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('saved') })
      props.onSaved()
    } catch (err) {
      toast({
        title: t('save_failed'),
        description: err instanceof Error ? getUserErrorMessage(err) : t('unknown_error'),
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
          title: t('clear_failed'),
          description: typeof data?.error === 'string' ? data.error : t('unknown_error'),
          variant: 'destructive',
        })
        return
      }
      setTaxStr('')
      setAvgStr('')
      setBasisStr('')
      setReason('')
      toast({ title: t('cleared') })
      props.onSaved()
    } finally {
      setSaving(false)
    }
  }

  const fieldDisabled = props.disabled || saving

  return (
    <DetailSection
      kicker={t('title')}
      help={<HelpPopover>{t('description')}</HelpPopover>}
      aside={
        // Chips mark exceptions: the chip appears only once an override is
        // in effect; the show/hide toggle is the section's one action.
        <span className="-my-1 flex items-center gap-3">
          {hasOverride && <Badge variant="warning">{t('adjusted_badge')}</Badge>}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            disabled={props.disabled}
          >
            {expanded ? t('hide') : t('show')}
          </Button>
        </span>
      }
    >
      {expanded && (
        <>
          <SettingsRow label={t('tax_label')} htmlFor="tax_override" align="baseline">
            <SettingsInput
              id="tax_override"
              inputMode="decimal"
              placeholder={String(props.taxWithheld)}
              value={taxStr}
              onChange={(e) => setTaxStr(e.target.value)}
              disabled={fieldDisabled}
              className={FIELD_CLASS}
            />
            <SettingsRowNote>
              {t('calculated')} <span className="tabular-nums">{formatCurrency(props.taxWithheld)}</span>
            </SettingsRowNote>
          </SettingsRow>

          <SettingsRow label={t('avgifter_label')} htmlFor="avgifter_override" align="baseline">
            <SettingsInput
              id="avgifter_override"
              inputMode="decimal"
              placeholder={String(props.avgifterAmount)}
              value={avgStr}
              onChange={(e) => setAvgStr(e.target.value)}
              disabled={fieldDisabled}
              className={FIELD_CLASS}
            />
            <SettingsRowNote>
              {t('calculated')} <span className="tabular-nums">{formatCurrency(props.avgifterAmount)}</span>
            </SettingsRowNote>
          </SettingsRow>

          <SettingsRow label={t('basis_label')} htmlFor="avgifter_basis_override" align="baseline">
            <SettingsInput
              id="avgifter_basis_override"
              inputMode="decimal"
              placeholder={String(props.avgifterBasis)}
              value={basisStr}
              onChange={(e) => setBasisStr(e.target.value)}
              disabled={fieldDisabled}
              className={FIELD_CLASS}
            />
            <SettingsRowNote>
              {t('calculated')} <span className="tabular-nums">{formatCurrency(props.avgifterBasis)}</span>
            </SettingsRowNote>
          </SettingsRow>

          <SettingsRow label={t('reason_label')} htmlFor="override_reason" align="baseline" borderless>
            <SettingsTextarea
              id="override_reason"
              rows={2}
              placeholder={t('reason_placeholder')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={fieldDisabled}
            />
          </SettingsRow>

          <div className="flex flex-wrap gap-2 pt-3">
            <Button size="sm" onClick={handleSave} disabled={fieldDisabled}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
            {hasOverride && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleClear}
                disabled={fieldDisabled}
              >
                {t('clear')}
              </Button>
            )}
          </div>
        </>
      )}
    </DetailSection>
  )
}
