'use client'

import { UUID_RE } from '@/lib/invariants/uuid'
import { Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useBranding } from '@/lib/branding/brand-context'

interface DocumentViewButtonProps {
  documentId: string
  label?: string
  className?: string
}


/**
 * Opens a document in the browser through the same-origin inline proxy
 * (/api/documents/:id/inline), which serves it with
 * `Content-Disposition: inline`: PDFs land in the browser's viewer and images
 * render, instead of the file dropping into the Downloads folder (#1190).
 *
 * The proxy authorizes with the caller's own client before the service-role
 * client reads the bucket, and no URL has to be minted first: navigation
 * happens straight from the click, so there is nothing for a popup blocker to
 * catch (the previous signed-URL fetch needed openDeferredTab for exactly that
 * reason). The browser's own viewer still offers saving the file.
 */
export function DocumentViewButton({ documentId, label = 'Visa dokument', className }: DocumentViewButtonProps) {
  const { toast } = useToast()
  const { appName } = useBranding()

  const handleClick = () => {
    // documentId originates from staged preview_data (Record<string, unknown>);
    // validate the shape before interpolating into the URL so a malformed
    // payload can't point the tab at another internal endpoint.
    if (!UUID_RE.test(documentId)) {
      toast({
        title: 'Ogiltigt dokument-ID',
        description: 'Försök ladda om sidan eller kontakta support.',
        variant: 'destructive',
      })
      return
    }

    // window.open() returns null BY SPEC when 'noopener' is in the features
    // string, even on success, so passing it here made this toast fire on
    // every successful open. Open with a real return value and sever the
    // reverse channel manually (same pattern as lib/browser/deferred-tab.ts).
    const tab = window.open(`/api/documents/${documentId}/inline`, '_blank')
    if (tab) {
      tab.opener = null
    } else {
      toast({
        title: 'Kunde inte öppna dokumentet',
        description: `Tillåt popupfönster för ${appName} i webbläsaren och försök igen.`,
        variant: 'destructive',
      })
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleClick}
      className={className}
    >
      <Eye className="mr-1.5 h-3.5 w-3.5" />
      {label}
    </Button>
  )
}
