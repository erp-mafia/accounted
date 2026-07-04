'use client'

import { useState, useCallback, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { AlertTriangle, Check, Copy, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { formatDateLong } from '@/lib/utils'
import type { CompanyInboundDomain, InboundDomainDnsRecord } from '@/types'

const BASE = '/api/extensions/ext/invoice-inbox/inbox/domain'

const STATUS_BADGE: Record<
  CompanyInboundDomain['status'],
  { label: string; variant: 'secondary' | 'success' | 'destructive' }
> = {
  pending: { label: 'Väntar på DNS', variant: 'secondary' },
  verified: { label: 'Verifierad', variant: 'success' },
  failed: { label: 'Misslyckades', variant: 'destructive' },
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Settings dialog for a company's own inbound domain. Claims the domain via
// the extension API, renders the DNS records the user must publish, and
// re-checks verification on demand. Everything mail-routing happens
// server-side: this surface only manages the claim lifecycle.
export default function InboxCustomDomainDialog({ open, onOpenChange }: Props) {
  const { toast } = useToast()
  const [isLoading, setIsLoading] = useState(true)
  const [domain, setDomain] = useState<CompanyInboundDomain | null>(null)
  const [domainInput, setDomainInput] = useState('')
  const [isClaiming, setIsClaiming] = useState(false)
  const [isChecking, setIsChecking] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)

  const fetchDomain = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch(BASE)
      const json = await res.json()
      if (res.ok) setDomain(json.data ?? null)
    } catch {
      // Leave the previous state; the dialog shows the claim form on null.
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) fetchDomain()
  }, [open, fetchDomain])

  const handleClaim = useCallback(async () => {
    if (!domainInput.trim()) return
    setIsClaiming(true)
    try {
      const res = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domainInput }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Kunde inte lägga till domänen')
      setDomain(json.data)
      setDomainInput('')
      toast({
        title: 'Domän tillagd',
        description: 'Lägg till DNS-posterna nedan hos din domänleverantör.',
      })
    } catch (err) {
      toast({
        title: 'Kunde inte lägga till domänen',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsClaiming(false)
    }
  }, [domainInput, toast])

  const handleVerify = useCallback(async () => {
    setIsChecking(true)
    try {
      const res = await fetch(`${BASE}/verify`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Kontrollen misslyckades')
      setDomain(json.data)
      toast(
        json.data.status === 'verified'
          ? { title: 'Domänen är verifierad', description: 'E-post till domänen landar nu i dokumentinkorgen.' }
          : { title: 'Inte verifierad än', description: 'DNS-ändringar kan ta upp till någon timme att slå igenom.' }
      )
    } catch (err) {
      toast({
        title: 'Kontrollen misslyckades',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsChecking(false)
    }
  }, [toast])

  const handleRemove = useCallback(async () => {
    if (!domain) return
    if (!confirm(`Ta bort ${domain.domain}? E-post till domänen slutar landa i Accounted.`)) return
    setIsRemoving(true)
    try {
      const res = await fetch(BASE, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Borttagningen misslyckades')
      setDomain(null)
      toast({ title: 'Domänen borttagen' })
    } catch (err) {
      toast({
        title: 'Borttagningen misslyckades',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsRemoving(false)
    }
  }, [domain, toast])

  const handleCopy = useCallback(
    (value: string) => {
      navigator.clipboard.writeText(value).catch(() => {})
      toast({ title: 'Kopierat' })
    },
    [toast]
  )

  const records: InboundDomainDnsRecord[] = domain?.dns_records ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Egen domän för inkorgen</DialogTitle>
          <DialogDescription>
            Ta emot leverantörsfakturor direkt på bolagets egen adress, t.ex.
            faktura@dittbolag.se: utan vidarebefordran.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !domain ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-border p-4 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
              <div className="space-y-1">
                <p className="font-medium">Viktigt om din domän redan tar emot e-post</p>
                <p className="text-muted-foreground">
                  Domänens MX-poster pekas om till Accounted. Om domänen redan används för
                  e-post (Google Workspace, Microsoft 365) slutar din vanliga e-post att
                  fungera: använd då en underdomän, t.ex.{' '}
                  <code className="font-mono text-xs">faktura.dittbolag.se</code>, eller
                  fortsätt vidarebefordra till din vanliga inkorgsadress.
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              <Input
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                placeholder="faktura.dittbolag.se"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleClaim()
                }}
              />
              <Button onClick={handleClaim} disabled={isClaiming || !domainInput.trim()}>
                {isClaiming ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Lägg till
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <code className="font-mono text-sm truncate">{domain.domain}</code>
                <Badge variant={STATUS_BADGE[domain.status].variant}>
                  {STATUS_BADGE[domain.status].label}
                </Badge>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="outline" size="sm" onClick={handleVerify} disabled={isChecking}>
                  {isChecking ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Kontrollera igen
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRemove}
                  disabled={isRemoving}
                  aria-label="Ta bort domän"
                >
                  {isRemoving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>

            {domain.status === 'verified' ? (
              <div className="flex items-start gap-3 rounded-lg border border-border p-4 text-sm">
                <Check className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                <div className="space-y-1">
                  <p className="font-medium">
                    Klart: ge dina leverantörer{' '}
                    <code className="font-mono text-xs">faktura@{domain.domain}</code>
                  </p>
                  <p className="text-muted-foreground">
                    Alla adresser på domänen fungerar; allt landar i dokumentinkorgen.
                    {domain.verified_at ? ` Verifierad ${formatDateLong(domain.verified_at)}.` : ''}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Lägg till posterna nedan hos din domänleverantör (Loopia, one.com,
                  Cloudflare …) och klicka sedan på Kontrollera igen. Ändringar kan ta upp
                  till någon timme att slå igenom.
                </p>
                {records.length > 0 ? (
                  <div className="rounded-lg border border-border overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Typ</th>
                          <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Namn</th>
                          <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Värde</th>
                          <th className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Prio</th>
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {records.map((r, i) => (
                          <tr key={`${r.type}-${r.name}-${i}`} className="border-b border-border last:border-0">
                            <td className="px-3 py-2 font-mono text-xs">{r.type}</td>
                            <td className="px-3 py-2 font-mono text-xs break-all">{r.name}</td>
                            <td className="px-3 py-2 font-mono text-xs break-all">{r.value}</td>
                            <td className="px-3 py-2 font-mono text-xs text-right tabular-nums">
                              {r.priority ?? '-'}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground"
                                onClick={() => handleCopy(r.value)}
                                aria-label={`Kopiera ${r.type}-värde`}
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Inga DNS-poster tillgängliga: klicka på Kontrollera igen.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
