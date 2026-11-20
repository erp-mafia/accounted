'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { SlideOver, SlideOverBody, SlideOverContent, SlideOverFooter, SlideOverHeader } from '@/components/ui/slide-over'

/**
 * The drawer a small record is created in, over its list (V7 creation forms,
 * F1): a customer, a supplier, an article. You keep your place in the list;
 * records with rows or a preview (invoice, voucher) stay full pages.
 *
 * The title is the create button's label without the plus ("Ny kund"). The
 * primary names the thing ("Skapa kund") and sits in the drawer's fixed
 * footer over the hairline with Avbryt beside it; it submits the form inside
 * through the `form` attribute, so the form keeps its own validation and
 * submit handler and only gives up its submit row (it takes `formId`).
 * Esc, the X, Avbryt and a click on the veil close it.
 */
export function CreateDrawer({
  open,
  onOpenChange,
  title,
  formId,
  submitLabel,
  submitting = false,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  /**
   * The id of the form inside: with it and `submitLabel` the drawer shows its
   * fixed footer and the primary submits that form. A host whose form still
   * carries its own buttons leaves both out and gets no footer.
   */
  formId?: string
  submitLabel?: string
  submitting?: boolean
  children: React.ReactNode
}) {
  const t = useTranslations('common')
  return (
    <SlideOver open={open} onOpenChange={onOpenChange}>
      <SlideOverContent aria-describedby={undefined}>
        <SlideOverHeader title={title} />
        {/* p-6: the forms were written for the dialog's 24px inset and bleed
            their footers by that much. */}
        <SlideOverBody className="p-6">{children}</SlideOverBody>
        {formId && submitLabel && (
          <SlideOverFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" form={formId} loading={submitting}>
              {submitLabel}
            </Button>
          </SlideOverFooter>
        )}
      </SlideOverContent>
    </SlideOver>
  )
}
