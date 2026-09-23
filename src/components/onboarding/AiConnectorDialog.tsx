'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** Keep the public MCP address selectable when automatic clipboard access fails. */
export function AiConnectorDialog({ action, onClose, onOpen }: {
  action: { open: string; copy: string | null } | null
  onClose: () => void
  onOpen?: () => void
}) {
  const t = useTranslations('books')
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  async function copy() {
    if (!action?.copy) return
    try {
      await navigator.clipboard.writeText(action.copy)
      setCopied(true)
      setFailed(false)
    } catch {
      setCopied(false)
      setFailed(true)
    }
  }
  return (
    <Dialog open={!!action} onOpenChange={(open) => { if (!open) { setCopied(false); setFailed(false); onClose() } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('ai_title')}</DialogTitle>
          <DialogDescription>{t('ai_connector_help')}</DialogDescription>
        </DialogHeader>
        <Input readOnly value={action?.copy ?? ''} aria-label={t('ai_connector_address')} onFocus={(event) => event.target.select()} />
        {failed ? <p role="status" className="text-sm text-muted-foreground">{t('ai_connector_copy_failed')}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => void copy()}>{t(copied ? 'ai_copied' : 'ai_connector_copy')}</Button>
          <Button asChild><a href={action?.open} target="_blank" rel="noopener noreferrer" onClick={onOpen}>{t('ai_connector_open')}</a></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
