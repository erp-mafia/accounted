'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { CompanyProfileView } from '@/components/settings/CompanyProfileView'
import { refreshCompanyProfileAction } from '@/lib/company/tic-refresh'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

type Snapshot = Parameters<typeof CompanyProfileView>[0]['snapshot']

const ERROR_MESSAGES: Record<string, string> = {
  org_number_invalid: 'Ogiltigt organisations- eller personnummer.',
  not_found: 'Inga bolagsuppgifter hittades för det numret.',
  unauthorized: 'Du har inte behörighet att hämta uppgifter.',
  persist_failed: 'Något gick fel. Försök igen.',
}

// Företagsprofil: the cached TIC company snapshot (Bolagsuppgifter), rendered
// as a read-only section on the Företag tab. Fetched client-side (low-traffic
// settings) so it sits alongside the client-rendered company form. RLS scopes
// the read to the user's own company. The "Hämta" form lets the user (re)fetch
// live when the snapshot is missing or wrong: the recovery path for an enskild
// firma whose personnummer previously resolved to the wrong entity.
export function CompanyProfileSection() {
  const { company } = useCompany()
  const [snapshot, setSnapshot] = useState<Snapshot>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [orgInput, setOrgInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!company?.id) return
    const supabase = createClient()
    let cancelled = false
    supabase
      .from('companies')
      .select('tic_snapshot, tic_snapshot_fetched_at, org_number')
      .eq('id', company.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setSnapshot((data?.tic_snapshot as Snapshot) ?? null)
        setFetchedAt((data?.tic_snapshot_fetched_at as string | null) ?? null)
        setOrgInput((data?.org_number as string | null) ?? '')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [company?.id])

  async function handleFetch(e: React.FormEvent) {
    e.preventDefault()
    if (!company?.id || submitting) return
    setSubmitting(true)
    setError(null)
    const result = await refreshCompanyProfileAction(company.id, orgInput)
    if (result.ok) {
      setSnapshot((result.snapshot as Snapshot) ?? null)
      setFetchedAt(result.fetchedAt ?? null)
    } else {
      setError(ERROR_MESSAGES[result.error ?? ''] ?? ERROR_MESSAGES.persist_failed)
    }
    setSubmitting(false)
  }

  if (loading) return <Skeleton className="h-48 w-full rounded-lg" />

  return (
    <div className="space-y-4">
      <CompanyProfileView snapshot={snapshot} fetchedAt={fetchedAt} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {snapshot ? 'Uppdatera bolagsuppgifter' : 'Hämta bolagsuppgifter'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleFetch} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tic_org_number">Organisationsnummer eller personnummer</Label>
              <div className="flex gap-2">
                <Input
                  id="tic_org_number"
                  value={orgInput}
                  onChange={(e) => setOrgInput(e.target.value)}
                  placeholder="XXXXXX-XXXX"
                  inputMode="numeric"
                  autoComplete="off"
                  className="max-w-xs tabular-nums"
                />
                <Button type="submit" disabled={submitting || !orgInput.trim()}>
                  {submitting ? (
                    <>
                      <Loader2 className="animate-spin" />
                      Hämtar…
                    </>
                  ) : (
                    'Hämta'
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Uppgifterna hämtas från Bolagsverket. För enskild firma anges
                personnumret.
              </p>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
