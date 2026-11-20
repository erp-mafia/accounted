'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, getResponseErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { resolveQuotePart, type QuoteConversion, type QuoteInvoicePart } from '@/lib/invoices/quote-partial-invoice'
import { quoteInvoicingProgress } from '@/lib/invoices/quote-status'
import { parseAmountInput, parseDecimalInput } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'

type Mode = 'percent' | 'amount'

interface QuotePartDialogProps {
  quote: { id: string; invoice_number: string | null; subtotal: number; currency: string }
  /** The live invoices converted from the quote (status, subtotal). */
  conversions: QuoteConversion[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * "Skapa delfaktura" (crm#1196): an invoice for a percent or a net amount of
 * an accepted quote. The dialog shows what the quote has been invoiced so far
 * and what the new invoice will bill before anything is created (convention
 * 10); the server resolves the part again with the same rule.
 */
export default function QuotePartDialog({ quote, conversions, open, onOpenChange }: QuotePartDialogProps) {
  const t = useTranslations('invoice_detail')
  const locale = useLocale() as ErrorLocale
  const router = useRouter()
  const { toast } = useToast()
  const [mode, setMode] = useState<Mode>('percent')
  const [value, setValue] = useState('')
  const [creating, setCreating] = useState(false)

  const parsed = mode === 'percent' ? parseDecimalInput(value) : parseAmountInput(value)
  const part: QuoteInvoicePart | null =
    parsed == null || parsed <= 0 || (mode === 'percent' && parsed > 100)
      ? null
      : mode === 'percent'
        ? { percent: parsed }
        : { amount: parsed }
  const progress = quoteInvoicingProgress(quote, conversions)
  const resolved = part ? resolveQuotePart(quote, conversions, part) : null
  const money = (n: number) => formatCurrency(n, quote.currency, { minimumFractionDigits: 2 })

  async function create() {
    if (!part || !resolved?.ok || creating) return
    setCreating(true)
    try {
      const response = await fetch(`/api/invoices/${quote.id}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(part),
      })
      if (!response.ok) {
        const description = await getResponseErrorMessage(response, 'invoice', locale)
        toast({ title: t('convert_failed_title'), description, variant: 'destructive' })
        setCreating(false)
        return
      }
      const body = (await response.json()) as { data: { id: string; invoice_number: string | null } }
      toast({
        title: t('converted_toast_title'),
        description: t('converted_toast_description', { number: body.data.invoice_number ?? '' }),
      })
      onOpenChange(false)
      router.push(`/invoices/${body.data.id}`)
    } catch (error) {
      toast({
        title: t('convert_failed_title'),
        description: getErrorMessage(error, { context: 'invoice', locale }),
        variant: 'destructive',
      })
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !creating && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('quote_part_title', { number: quote.invoice_number ?? '' })}</DialogTitle>
          <DialogDescription>{t('quote_part_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-[13px] tabular-nums text-muted-foreground">
            {t('quote_part_summary', {
              total: money(quote.subtotal),
              invoiced: money(progress.invoiced),
              remaining: money(progress.remaining),
            })}
          </p>
          <SegmentedControl
            value={mode}
            onChange={(next) => {
              setMode(next)
              setValue('')
            }}
            aria-label={t('quote_part_mode_label')}
            options={[
              { value: 'percent', label: t('quote_part_mode_percent') },
              { value: 'amount', label: t('quote_part_mode_amount') },
            ]}
          />
          <div className="space-y-2">
            <Label htmlFor="quote-part-value">
              {t(mode === 'percent' ? 'quote_part_input_percent' : 'quote_part_input_amount')}
            </Label>
            <Input
              id="quote-part-value"
              inputMode="decimal"
              autoComplete="off"
              className="tabular-nums"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create()
              }}
            />
          </div>
          {value.trim() !== '' && (
            <p className="text-[13px] tabular-nums">
              {resolved?.ok
                ? t(resolved.rest ? 'quote_part_preview_rest' : 'quote_part_preview', { amount: money(resolved.amount) })
                : t('quote_part_invalid', { remaining: money(progress.remaining) })}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            {t('quote_part_cancel')}
          </Button>
          <Button onClick={() => void create()} disabled={!resolved?.ok} loading={creating}>
            {t('quote_create_part')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
