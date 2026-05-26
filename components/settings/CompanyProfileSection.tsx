'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { CompanyProfileView } from '@/components/settings/CompanyProfileView'
import { Skeleton } from '@/components/ui/skeleton'

type Snapshot = Parameters<typeof CompanyProfileView>[0]['snapshot']

// Företagsprofil — the cached TIC company snapshot (Bolagsuppgifter), rendered
// as a read-only section on the Företag tab. Fetched client-side (low-traffic
// settings) so it sits alongside the client-rendered company form. RLS scopes
// the read to the user's own company.
export function CompanyProfileSection() {
  const { company } = useCompany()
  const [snapshot, setSnapshot] = useState<Snapshot>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!company?.id) return
    const supabase = createClient()
    let cancelled = false
    supabase
      .from('companies')
      .select('tic_snapshot, tic_snapshot_fetched_at')
      .eq('id', company.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setSnapshot((data?.tic_snapshot as Snapshot) ?? null)
        setFetchedAt((data?.tic_snapshot_fetched_at as string | null) ?? null)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [company?.id])

  if (loading) return <Skeleton className="h-48 w-full rounded-lg" />

  return <CompanyProfileView snapshot={snapshot} fetchedAt={fetchedAt} />
}
