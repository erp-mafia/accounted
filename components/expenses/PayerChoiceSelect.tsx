'use client'

import { useTranslations } from 'next-intl'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { PAYER_ORDER, type PayerChoice } from '@/lib/expenses/payer'
import type { AccountingMethod } from '@/types'

export type { ExpensePayer, PayerChoice } from '@/lib/expenses/payer'

/**
 * The "Vem betalade?" control, shared by the Underlag pane and the
 * supplier-invoice form: a compact select so a rail keeps its primary button
 * above the fold, with the chosen answer's one-line consequence under it.
 * Each option in the list carries the same help so the choice is made with
 * the consequence visible, not after.
 *
 * 'company' -> match the bank line; 'unpaid' -> supplier invoice (2440);
 * 'owner' / 'employee' -> utlägg against the person's liability account.
 */
export function PayerChoiceSelect({
  value,
  onChange,
  accountingMethod,
  id,
  labelClassName,
  disabled,
}: {
  value: PayerChoice
  onChange: (next: PayerChoice) => void
  accountingMethod: AccountingMethod
  /** Trigger id, so a host can point a label or focus router at it. */
  id?: string
  /** Overrides the rail's label style when the control sits in a form grid. */
  labelClassName?: string
  disabled?: boolean
}) {
  const t = useTranslations('inbox_workspace')
  // An enskild firma owner makes an egen insättning, not a loan to the
  // company: no debt, nothing to pay out, so the help line says so.
  const isEf = useCompanyOptional()?.company?.entity_type === 'enskild_firma'
  // Företaget carries no help line: the button under it ("Matcha mot
  // transaktion") already says what happens. The other answers name the
  // liability the company takes on, which is the consequence worth reading.
  const helpKey = (choice: PayerChoice): string | null =>
    choice === 'company'
      ? null
      : choice === 'owner' && isEf
        ? 'payer_help_owner_ef'
        : choice === 'unpaid' && accountingMethod === 'cash'
          ? 'payer_help_unpaid_cash'
          : `payer_help_${choice}`
  const selectedHelp = helpKey(value)
  return (
    <div className="space-y-1.5">
      <p className={labelClassName ?? 'text-[13px] font-medium'}>{t('payer_question')}</p>
      <Select value={value} onValueChange={(next) => onChange(next as PayerChoice)} disabled={disabled}>
        <SelectTrigger id={id} aria-label={t('payer_question')} className="h-9 text-[13px]">
          {/* Explicit children: the items render label + help, and the
              trigger must show the label alone. */}
          <SelectValue>{t(`payer_${value}`)}</SelectValue>
        </SelectTrigger>
        {/* Match the trigger width so the two-line options wrap inside the rail
            instead of spilling over the document viewer. */}
        <SelectContent align="start" className="w-[var(--radix-select-trigger-width)]">
          {PAYER_ORDER.map((choice) => (
            <SelectItem key={choice} value={choice} className="py-2">
              <span className="block text-[13px]">{t(`payer_${choice}`)}</span>
              {helpKey(choice) && (
                <span className="block text-xs text-muted-foreground">{t(helpKey(choice)!)}</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selectedHelp && <p className="text-xs text-muted-foreground">{t(selectedHelp)}</p>}
    </div>
  )
}
