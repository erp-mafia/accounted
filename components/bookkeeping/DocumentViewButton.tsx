'use client'

import { useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'

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
    try {
      const res = await fetch(`/api/documents/${documentId}`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.data?.download_url) {
        toast({
          title: 'Kunde inte öppna dokumentet',
          description: json?.error || 'Försök igen om en stund.',
          variant: 'destructive',
        })
        return
      }
      window.open(json.data.download_url as string, '_blank', 'noopener,noreferrer')
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
