'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  isPurchaseCategoryCode,
  purchaseCategoryNameKey,
  type PurchaseCategoryCode,
} from '@/lib/categories/purchase-categories'
import type { InboxPurchaseCategory } from '@/lib/categories/inbox-purchase-category'
import type { PurchaseCategoryAlternative, PurchaseCategorySource } from '@/lib/categories/propose-purchase-category'
import { PurchaseCategoryPicker, type PurchaseCategorySuggestion } from './PurchaseCategoryPicker'

const LEVEL_KEY = { 'Ditt val': 'level_person', Stark: 'level_strong', Trolig: 'level_likely' } as const

/** The evidence an alternative rests on, in the picker's words. */
const SOURCE_KEY = {
  counterparty: 'source_counterparty',
  lines: 'source_lines',
  account: 'source_account',
  merchant_category: 'source_merchant_category',
} as const satisfies Partial<Record<PurchaseCategorySource, string>>

/**
 * What the underlag bought, as the inbox reads it (purchase_category), with
 * an "Ändra" dialog that stores a person's own choice. Given the matched
 * supplier, the dialog offers "varje gång": the choice then also becomes the
 * instruction for that supplier, which later underlag from it read as Ditt
 * val. It never changes a choice made on another single underlag. The
 * category is a label beside the kontering, never the booking: changing it
 * books nothing.
 *
 * The dialog searches the whole list (PurchaseCategoryPicker) and opens on
 * Förslag: what the item reads now with its level, then the alternatives the
 * detail read found in the evidence, each with what it rests on.
 */
export function PurchaseCategoryChip({
  itemId,
  value,
  locked = false,
  supplierName = null,
  onChange,
  label,
  alternatives = null,
  prompt = false,
}: {
  itemId: string
  value: InboxPurchaseCategory | null | undefined
  /** Converted to a supplier invoice: the reading, and so the choice, is frozen. */
  locked?: boolean
  /**
   * The item's matched supplier (matched_supplier_id), by name. Given, the
   * dialog offers "varje gång" for it; leave it out when the item has no
   * matched supplier, since there is nobody to remember the choice for.
   */
  supplierName?: string | null
  /** After a saved choice, with what the item reads now. */
  onChange?: (next: InboxPurchaseCategory | null) => void
  /** Replaces the "Kategori" label in front of the chip; null leaves it out (the caller says what the chip is). */
  label?: ReactNode | null
  /**
   * What else the evidence points to (the detail read's
   * purchase_category_alternatives), offered under Förslag. Leave it out
   * where the read has none: the dialog then offers the proposal alone.
   */
  alternatives?: readonly PurchaseCategoryAlternative[] | null
  /** Nothing chosen and the page waits for it: "Välj kategori" opens the dialog in place of "Ingen kategori". */
  prompt?: boolean
}) {
  const t = useTranslations('purchase_category_picker')
  const tc = useTranslations('purchaseCategories')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [current, setCurrent] = useState<InboxPurchaseCategory | null>(value ?? null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<PurchaseCategoryCode | ''>('')
  const [everyTime, setEveryTime] = useState(false)
  const [saving, setSaving] = useState<'save' | 'clear' | null>(null)
  const everyTimeId = useId()
  const hintId = useId()
  const searchRef = useRef<HTMLInputElement>(null)

  // The detail read is the source of truth; a new item (or a re-read) replaces the local copy.
  useEffect(() => {
    setCurrent(value ?? null)
  }, [itemId, value])

  function openDialog() {
    setDraft(current?.code ?? '')
    setEveryTime(Boolean(supplierName) && current?.source === 'instruction')
    setOpen(true)
  }

  async function save(code: PurchaseCategoryCode | null, mode: 'save' | 'clear') {
    setSaving(mode)
    try {
      const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}/purchase-category`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // every_time only when the box is offered and ticked: otherwise this underlag alone.
        body: JSON.stringify(supplierName && everyTime ? { code, every_time: true } : { code }),
      })
      const json = (await res.json().catch(() => null)) as { data?: { purchase_category?: InboxPurchaseCategory | null } } | null
      if (!res.ok) {
        toast({ title: getErrorMessage(json, { statusCode: res.status, locale, fallback: t('save_failed') }), variant: 'destructive' })
        return
      }
      const next = json?.data?.purchase_category ?? null
      setCurrent(next)
      setOpen(false)
      onChange?.(next)
    } catch {
      toast({ title: t('save_failed'), variant: 'destructive' })
    } finally {
      setSaving(null)
    }
  }

  function sourceHint(source: PurchaseCategorySource): string {
    if (source === 'person') return t('level_person')
    if (source === 'instruction') return supplierName ? t('from_instruction', { supplier: supplierName }) : t('from_instruction_plain')
    return t(SOURCE_KEY[source])
  }

  // Förslag: what the item reads now, with its level; then the read's own
  // proposal when a save in this session replaced it; then the alternatives.
  // Never a code this build cannot pick, never one twice.
  const suggestions: PurchaseCategorySuggestion[] = []
  const offer = (code: string, hint: string) => {
    if (isPurchaseCategoryCode(code) && !suggestions.some((s) => s.code === code)) suggestions.push({ code, hint })
  }
  if (current) offer(current.code, t(LEVEL_KEY[current.level]))
  if (value && value.source !== 'person' && value.source !== 'instruction') offer(value.code, sourceHint(value.source))
  for (const alternative of alternatives ?? []) offer(alternative.code, sourceHint(alternative.source))

  const fromInstruction = current?.source === 'instruction'
  // Clearing an instruction is "varje gång" with no category: offered while the box is ticked.
  const clearable = current?.source === 'person' || (fromInstruction && everyTime)

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {label !== null && <span className="text-muted-foreground">{label ?? t('label')}</span>}
      {current ? (
        <span className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5">
          {/* A code this build does not know (an older or newer list) shows as itself, never as a message key. */}
          <span className="min-w-0 truncate">{isPurchaseCategoryCode(current.code) ? tc(purchaseCategoryNameKey(current.code)) : current.code}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{t(LEVEL_KEY[current.level])}</span>
        </span>
      ) : prompt && !locked ? (
        <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={openDialog}>
          {t('pick')}
        </Button>
      ) : (
        <span className="text-muted-foreground">{t('none')}</span>
      )}
      {fromInstruction && (
        <span className="text-muted-foreground">
          {supplierName ? t('from_instruction', { supplier: supplierName }) : t('from_instruction_plain')}
        </span>
      )}
      {!locked && (current || !prompt) && (
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
          aria-label={t('change_label')}
          onClick={openDialog}
        >
          {t('change')}
        </Button>
      )}

      <Dialog open={open} onOpenChange={(next) => (saving ? undefined : setOpen(next))}>
        <DialogContent
          // On a touch screen the dialog itself holds focus (below): no outline for that.
          className="focus-visible:outline-none sm:max-w-lg"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            // The search field takes focus, except on a touch screen, where it
            // would raise a keyboard over Förslag: there the dialog holds it.
            if (window.matchMedia('(pointer: coarse)').matches) (e.currentTarget as HTMLElement | null)?.focus()
            else searchRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {supplierName ? t('dialog_title_supplier', { supplier: supplierName }) : t('dialog_title')}
            </DialogTitle>
            <DialogDescription>{t('dialog_description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <PurchaseCategoryPicker
              value={draft}
              onPick={setDraft}
              onSubmit={() => {
                if (draft && saving === null) void save(draft, 'save')
              }}
              suggestions={suggestions}
              inputRef={searchRef}
            />
            {supplierName && (
              <div className="space-y-1">
                <label htmlFor={everyTimeId} className="flex items-center gap-2 text-[13px]">
                  <Checkbox
                    id={everyTimeId}
                    checked={everyTime}
                    onCheckedChange={(v) => setEveryTime(v === true)}
                    aria-describedby={hintId}
                  />
                  {t('every_time', { supplier: supplierName })}
                </label>
                <p id={hintId} className="pl-6 text-[12.5px] text-muted-foreground">
                  {t('every_time_hint', { supplier: supplierName })}
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            {clearable && (
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                loading={saving === 'clear'}
                disabled={saving !== null}
                onClick={() => void save(null, 'clear')}
              >
                {t('clear')}
              </Button>
            )}
            <Button type="button" variant="outline" disabled={saving !== null} onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              type="button"
              loading={saving === 'save'}
              disabled={!draft || saving !== null}
              onClick={() => draft && void save(draft, 'save')}
            >
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
