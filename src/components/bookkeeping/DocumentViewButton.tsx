'use client'

import { UUID_RE } from '@/lib/invariants/uuid'
import { Eye } from 'lucide-react'
import { useTranslations } from 'next-intl'
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
export function DocumentViewButton({ documentId, label, className }: DocumentViewButtonProps) {
  const t = useTranslations('document_view_button')
  const tc = useTranslations('common')
  const { toast } = useToast()
  const { appName } = useBranding()

  const handleClick = () => {
    // documentId originates from staged preview_data (Record<string, unknown>);
    // validate the shape before interpolating into the URL so a malformed
    // payload can't point the tab at another internal endpoint.
    if (!UUID_RE.test(documentId)) {
      toast({
        title: t('invalid_id_title'),
        description: t('invalid_id_description'),
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
        title: t('open_failed_title'),
        description: tc('popup_blocked_description', { appName }),
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
      {label ?? t('default_label')}
    </Button>
  )
}
