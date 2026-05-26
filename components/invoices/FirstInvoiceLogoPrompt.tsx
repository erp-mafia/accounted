'use client'

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
}

/**
 * One-shot dialog offered after the user creates their first invoice and has
 * no logo on file. Reuses the same LogoUpload control as settings, so the
 * upload, MIME validation, and preview are identical to the canonical flow.
 *
 * The PDF reads logo_url live at render time, so uploading now still applies
 * to the just-created invoice when it is later previewed or sent.
 */
export function FirstInvoiceLogoPrompt({
  open,
  onClose,
  logoUrl,
  onLogoUpdate,
}: FirstInvoiceLogoPromptProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl tracking-tight">
            Lägg till en logotyp?
          </DialogTitle>
          <DialogDescription>
            Din första faktura är skapad. Vill du ladda upp en logotyp som
            visas i sidhuvudet? Du kan ändra den senare i{' '}
            <a
              href="/settings/company"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Inställningar
            </a>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <LogoUpload logoUrl={logoUrl} onUpdate={onLogoUpdate} />
        </div>

        <DialogFooter>
          <Button variant={logoUrl ? 'default' : 'ghost'} onClick={onClose}>
            {logoUrl ? 'Klar' : 'Hoppa över'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
