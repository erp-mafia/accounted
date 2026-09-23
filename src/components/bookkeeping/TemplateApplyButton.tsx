'use client'

import { useCallback, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CategoryPopover } from '@/components/transactions/CategoryPopover'
import TemplatePicker from '@/components/transactions/TemplatePicker'
import { applyTemplate } from '@/lib/bookkeeping/template-library'
import { staticTemplateToFormLines } from '@/lib/bookkeeping/proposal-lines'
import type { BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import { useCompany } from '@/contexts/CompanyContext'
import { roundOre } from '@/lib/money'
import type { BookingTemplateCategory, BookingTemplateLibrary, EntityType } from '@/types'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'

interface Props {
  onApply: (lines: FormLine[], description: string, category?: BookingTemplateCategory) => void
  entityType?: EntityType
  /** The total the caller already knows (an underlag's amount); the person can still change it. */
  defaultAmount?: number
  disabled?: boolean
}

type Picked = { kind: 'library'; raw: BookingTemplateLibrary } | { kind: 'static'; template: BookingTemplate }

function parseAmount(raw: string): number {
  const n = parseFloat(raw.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? roundOre(n) : 0
}

/**
 * "Använd mall" for the forms that write a whole verifikat (Ny verifikation,
 * Bokför direkt): the same picker as beside a bank row, with one thing a
 * bank row already has and a form does not, the total. With a valid total
 * a click on a template applies it; without one the template is held and
 * the total field takes focus.
 */
export default function TemplateApplyButton({ onApply, entityType, defaultAmount, disabled }: Props) {
  const t = useTranslations('tx_template_picker')
  const { company } = useCompany()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [amount, setAmount] = useState('')
  const [picked, setPicked] = useState<Picked | null>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const resolvedEntity = entityType ?? company?.entity_type

  const close = useCallback(() => setAnchor(null), [])

  // Opening starts clean: nothing held, the total the caller knows prefilled.
  const open = (button: HTMLElement) => {
    setPicked(null)
    setAmount(defaultAmount != null && defaultAmount > 0 ? String(roundOre(defaultAmount)) : '')
    setAnchor(button)
  }

  const apply = useCallback(
    (choice: Picked, total: number) => {
      if (choice.kind === 'library') {
        onApply(applyTemplate(choice.raw.lines, total), choice.raw.name, choice.raw.category)
      } else {
        onApply(staticTemplateToFormLines(choice.template, total, resolvedEntity), choice.template.name_sv)
      }
      setAnchor(null)
    },
    [onApply, resolvedEntity],
  )

  const choose = (choice: Picked) => {
    const total = parseAmount(amount)
    if (total > 0) return apply(choice, total)
    setPicked(choice)
    amountRef.current?.focus()
    amountRef.current?.select()
  }

  const submit = () => {
    const total = parseAmount(amount)
    if (picked && total > 0) apply(picked, total)
  }

  const pickedId = picked ? (picked.kind === 'library' ? picked.raw.id : picked.template.id) : undefined

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={(e) => (anchor ? close() : open(e.currentTarget))}
      >
        <BookOpen className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        {t('use_template')}
      </Button>
      {anchor && (
        <CategoryPopover anchor={anchor} onClose={close}>
          <div />
          <div className="flex min-h-0 flex-col overflow-hidden">
            <TemplatePicker
              direction="all"
              entityType={resolvedEntity}
              dense
              includeSystemLibrary
              selectedTemplateId={pickedId}
              onSelect={(template) => choose({ kind: 'static', template })}
              onPickLibraryTemplate={(raw) => choose({ kind: 'library', raw })}
            />
          </div>
          <form
            className="flex items-center gap-2 border-t border-border/70 bg-background px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <label htmlFor="template-apply-amount" className="shrink-0 text-[12px] text-muted-foreground">
              {t('amount_label')}
            </label>
            <Input
              id="template-apply-amount"
              ref={amountRef}
              inputMode="decimal"
              placeholder="0,00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-8 flex-1 tabular-nums"
            />
            <Button type="submit" size="sm" className="h-8" disabled={!picked || parseAmount(amount) <= 0}>
              {t('apply')}
            </Button>
          </form>
        </CategoryPopover>
      )}
    </>
  )
}
