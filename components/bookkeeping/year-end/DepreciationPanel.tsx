'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import type { Asset } from '@/types'

interface ProposalItem {
  asset: Asset
  amount: number
  netBookValueAfter: number
  proRated: boolean
  existingScheduleId?: string
  existingJournalEntryId?: string | null
}

interface Proposal {
  fiscalPeriod: { id: string; name: string; period_start: string; period_end: string }
  items: ProposalItem[]
  totalAmount: number
}

interface DepreciationPanelProps {
  periodId: string
  /** Called after a successful post: parent refetches dispositions because
   *  posted avskrivningar change the result which affects bolagsskatt etc. */
  onPosted: () => void
}

export function DepreciationPanel({ periodId, onPosted }: DepreciationPanelProps) {
  const { toast } = useToast()
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/depreciation`)
      const body = await res.json()
      if (!res.ok) {
        setError(body?.error?.message ?? 'Kunde inte ladda avskrivningar')
        return
      }
      setProposal(body.data as Proposal)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Okänt fel')
    } finally {
      setLoading(false)
    }
  }, [periodId])

  useEffect(() => {
    void load()
  }, [load])

  const handlePost = useCallback(async () => {
    setPosting(true)
    try {
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/depreciation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body?.error?.message ?? 'Kunde inte bokföra avskrivningar')
        return
      }
      const posted = body.data?.posted?.length ?? 0
      toast({
        title: `${posted} avskrivning${posted === 1 ? '' : 'ar'} bokförd${
          posted === 1 ? '' : 'a'
        }`,
      })
      onPosted()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Okänt fel')
    } finally {
      setPosting(false)
    }
  }, [periodId, onPosted, load, toast])

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-2">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-destructive">{error}</CardContent>
      </Card>
    )
  }

  if (!proposal) return null

  const allPosted =
    proposal.items.length > 0 && proposal.items.every((i) => Boolean(i.existingJournalEntryId))
  const anyPending =
    proposal.items.length > 0 && proposal.items.some((i) => !i.existingJournalEntryId)

  if (proposal.items.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Planenliga avskrivningar</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Inga aktiva anläggningstillgångar att skriva av.{' '}
          <Link href="/assets" className="text-primary hover:underline">
            Lägg till tillgångar
          </Link>{' '}
          så räknar bokslutet ut avskrivningarna automatiskt.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <CardTitle className="text-base">Planenliga avskrivningar</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {proposal.items.length} tillgång{proposal.items.length === 1 ? '' : 'ar'}.
              {allPosted ? ' Allt redan bokfört.' : ' Bokförs som separata verifikationer.'}
            </p>
          </div>
          <p className="font-display text-2xl tabular-nums shrink-0">
            {formatCurrency(proposal.totalAmount)}
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tillgång</TableHead>
              <TableHead className="text-right">Avskrivning</TableHead>
              <TableHead className="text-right">Restvärde</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {proposal.items.map((item) => (
              <TableRow key={item.asset.id}>
                <TableCell className="text-sm">{item.asset.name}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(item.amount)}
                  {item.proRated && (
                    <span className="block text-[10px] text-muted-foreground">pro-rata</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(item.netBookValueAfter)}
                </TableCell>
                <TableCell>
                  {item.existingJournalEntryId ? (
                    <Badge variant="success">Bokförd</Badge>
                  ) : (
                    <Badge variant="outline">Föreslagen</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {anyPending && (
          <div className="flex justify-end">
            <Button onClick={handlePost} disabled={posting}>
              {posting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Bokför…
                </>
              ) : (
                'Bokför alla avskrivningar'
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
