'use client'

import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { LogoUpload } from '@/components/settings/LogoUpload'

interface FirstInvoiceLogoPromptProps {
  open: boolean
  onClose: () => void
  logoUrl: string | null
  onLogoUpdate: (url: string | null) => void
  /** The document about to be created, lower case ("faktura", "offert"). */
  documentLabel: string
}

/**
 * One-shot dialog offered when the company's very first document is about to
 * be created and there is no logo on file: the editor opens it in front of
 * the send confirmation, so nothing exists yet and a logo uploaded here is on
 * the PDF that goes out. Reuses the same LogoUpload control as settings, so
 * the upload, MIME validation, and preview are identical to the canonical
 * flow.
 */
export function FirstInvoiceLogoPrompt({
  open,
  onClose,
  logoUrl,
  onLogoUpdate,
  documentLabel,
}: FirstInvoiceLogoPromptProps) {
  const t = useTranslations('first_invoice_logo_prompt')
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl tracking-tight">
            {t('title')}
          </DialogTitle>
          <DialogDescription>
            {t.rich('description', {
              doc: documentLabel,
              link: (chunks) => (
                <a href="/settings/company" className="underline underline-offset-2 hover:text-foreground">
                  {chunks}
                </a>
              ),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <LogoUpload logoUrl={logoUrl} onUpdate={onLogoUpdate} />
        </div>

        <DialogFooter>
          <Button variant={logoUrl ? 'default' : 'ghost'} onClick={onClose}>
            {logoUrl ? t('done') : t('skip')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
