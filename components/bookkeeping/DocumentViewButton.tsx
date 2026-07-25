'use client'

import { useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { openDeferredTab } from '@/lib/browser/deferred-tab'

interface DocumentViewButtonProps {
  documentId: string
  label?: string
  className?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Opens a document's signed download URL in a new tab. The signed URL is
 * minted on demand via /api/documents/:id (60 min TTL), so we don't bake
 * stale URLs into the preview payload.
 */
export function DocumentViewButton({ documentId, label = 'Visa dokument', className }: DocumentViewButtonProps) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)

  const handleClick = async () => {
    // documentId originates from staged preview_data (Record<string, unknown>);
    // validate the shape before interpolating into the request URL so a malformed
    // payload can't redirect the fetch at another internal endpoint.
    if (!UUID_RE.test(documentId)) {
      toast({
        title: 'Ogiltigt dokument-ID',
        description: 'Försök ladda om sidan eller kontakta support.',
        variant: 'destructive',
      })
      return
    }
    setLoading(true)
    // Pre-open inside the click's user activation: a window.open after the
    // await is popup-blocked when the signed-URL fetch is slow.
    const tab = openDeferredTab('Laddar...')
    try {
      const res = await fetch(`/api/documents/${documentId}`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.data?.download_url) {
        tab.close()
        toast({
          title: 'Kunde inte öppna dokumentet',
          description: json?.error || 'Försök igen om en stund.',
          variant: 'destructive',
        })
        return
      }
      if (!tab.navigate(json.data.download_url as string)) {
        tab.close()
        toast({
          title: 'Kunde inte öppna dokumentet',
          description: tab.blocked
            ? 'Tillåt popupfönster för Accounted i webbläsaren och försök igen.'
            : 'Försök igen om en stund.',
          variant: 'destructive',
        })
      }
    } catch {
      tab.close()
      toast({ title: 'Kunde inte öppna dokumentet', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={loading}
      className={className}
    >
      {loading ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : (
        <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
      )}
      {label}
    </Button>
  )
}
