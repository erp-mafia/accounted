'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { useToast } from '@/components/ui/use-toast'
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

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('sv-SE', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">{t('title')}</CardTitle>
              <CardDescription>
                {t('description')}
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => setShowCreateDialog(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('register_uri')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
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
            <div className="space-y-3">
              {clients.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between rounded-md border px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{c.client_name}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <code className="text-xs text-muted-foreground font-mono truncate">
                        {c.redirect_uri}
                      </code>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {t('registered_on')} {formatDate(c.created_at)}
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRevoke(c.id, c.client_name)}
                    aria-label={t('revoke_aria', { name: c.client_name })}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('register_dialog_title')}</DialogTitle>
            <DialogDescription>
              {t.rich('register_dialog_description', {
                bold: (chunks) => <span className="font-medium">{chunks}</span>,
                code: (chunks) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{chunks}</code>,
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
    </div>
  )
}
