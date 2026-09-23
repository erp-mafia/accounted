'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { HelpPopover } from '@/components/ui/help-popover'
import { useToast } from '@/components/ui/use-toast'
import { SettingsGroup } from '@/components/settings/SettingsRows'
import { formatDateLong } from '@/lib/utils'
import { Loader2, Plus, Trash2, Globe } from 'lucide-react'

interface OAuthClient {
  id: string
  client_name: string
  redirect_uri: string
  created_at: string
  revoked_at: string | null
}

export function OAuthClientsPanel() {
  const t = useTranslations('settings_oauth_clients')
  const locale = useLocale()
  const { toast } = useToast()
  const { dialogProps: revokeDialogProps, confirm: confirmRevoke } = useDestructiveConfirm()

  const [clients, setClients] = useState<OAuthClient[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [clientName, setClientName] = useState('')
  const [redirectUri, setRedirectUri] = useState('')

  const fetchClients = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/oauth-clients')
      const json = await res.json()
      if (json.data) {
        setClients(json.data.filter((c: OAuthClient) => !c.revoked_at))
      }
    } catch {
      toast({ title: t('toast_fetch_failed'), variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [toast, t])

  useEffect(() => {
    fetchClients()
  }, [fetchClients])

  async function handleCreate() {
    setIsCreating(true)
    try {
      const res = await fetch('/api/settings/oauth-clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: clientName.trim() || t('default_client_name'),
          redirect_uri: redirectUri.trim(),
        }),
      })
      const json = await res.json()

      if (!res.ok) {
        toast({ title: json.error ?? t('toast_register_failed'), variant: 'destructive' })
        return
      }

      setShowCreateDialog(false)
      setClientName('')
      setRedirectUri('')
      fetchClients()
    } catch {
      toast({ title: t('toast_register_failed'), variant: 'destructive' })
    } finally {
      setIsCreating(false)
    }
  }

  async function handleRevoke(id: string, name: string) {
    const ok = await confirmRevoke({
      title: t('revoke_dialog_title'),
      description: t('revoke_dialog_description', { name }),
      confirmLabel: t('revoke_confirm'),
    })
    if (!ok) return

    try {
      const res = await fetch(`/api/settings/oauth-clients/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        toast({
          title: body?.error || t('toast_revoke_failed'),
          variant: 'destructive',
        })
        return
      }
      setClients((prev) => prev.filter((c) => c.id !== id))
      toast({ title: t('toast_revoked') })
    } catch {
      toast({ title: t('toast_revoke_failed'), variant: 'destructive' })
    }
  }

  return (
    <>
      <SettingsGroup>
        {/* Group eyebrow with the group's primary action on the right. Styling
            mirrors SettingsGroup's label line; the "?" holds the old panel
            description. */}
        <div className="flex items-center justify-between gap-4 px-1">
          <p className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <span>{t('title')}</span>
            <HelpPopover className="shrink-0">{t('description')}</HelpPopover>
          </p>
          <Button size="sm" onClick={() => setShowCreateDialog(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('register_uri')}
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : clients.length === 0 ? (
          <EmptyState
            icon={Globe}
            title={t('empty_title')}
            description={t('empty_help')}
          />
        ) : (
          clients.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 border-b border-border px-1 py-3"
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="truncate text-sm">{c.client_name}</span>
                <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {c.redirect_uri}
                </code>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {t('registered_on')} {formatDateLong(c.created_at, locale)}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => handleRevoke(c.id, c.client_name)}
                aria-label={t('revoke_aria', { name: c.client_name })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))
        )}
      </SettingsGroup>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('register_dialog_title')}</DialogTitle>
            <DialogDescription>
              {t.rich('register_dialog_description', {
                bold: (chunks) => <span className="font-medium">{chunks}</span>,
                code: (chunks) => <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px]">{chunks}</code>,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="client-name">{t('client_name_label')}</Label>
              <Input
                id="client-name"
                placeholder={t('client_name_placeholder')}
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="redirect-uri">{t('redirect_uri_label')}</Label>
              <Input
                id="redirect-uri"
                type="url"
                placeholder="https://min-agent.exempel.se/oauth/callback"
                value={redirectUri}
                onChange={(e) => setRedirectUri(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && redirectUri && handleCreate()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={isCreating || !redirectUri.trim()}>
              {isCreating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t('register')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DestructiveConfirmDialog {...revokeDialogProps} />
    </>
  )
}
