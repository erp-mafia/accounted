'use client'

import { useEffect, useState } from 'react'
import type { VatPeriodType } from '@/types'
import type { VatSettlementProposal } from '@/lib/reports/vat-settlement'
import {
  findDraftVatSettlement,
  findPostedVatSettlement,
  vatSettlementBookingStatus,
} from '@/lib/reports/vat-settlement'

/**
 * Loads the settlement proposal for the open momsperiod so Granska can show
 * the already-booked banner without waiting for steg 3. Same endpoint as
 * VatBookingCard; tagged by fetch key so a period switch never flashes the
 * previous period's voucher.
 */
export function useVatSettlementProposal(opts: {
  periodType: VatPeriodType | null
  year: number
  period: number
  fiscalPeriodId?: string
  enabled: boolean
  refreshKey?: number
}) {
  const { periodType, year, period, fiscalPeriodId, enabled, refreshKey = 0 } = opts
  const fetchKey =
    enabled && periodType
      ? `${periodType}:${year}:${period}:${fiscalPeriodId ?? ''}:${refreshKey}`
      : null

  const [result, setResult] = useState<{
    key: string
    proposal?: VatSettlementProposal
    failed?: boolean
  } | null>(null)

  useEffect(() => {
    if (!fetchKey || !periodType) return
    const params = new URLSearchParams({
      periodType,
      year: String(year),
      period: String(period),
    })
    if (fiscalPeriodId) params.set('fiscal_period_id', fiscalPeriodId)
    let cancelled = false
    fetch(`/api/reports/vat-declaration/settlement-proposal?${params.toString()}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok || !json?.data) setResult({ key: fetchKey, failed: true })
        else setResult({ key: fetchKey, proposal: json.data })
      })
      .catch(() => {
        if (!cancelled) setResult({ key: fetchKey, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [fetchKey, periodType, year, period, fiscalPeriodId])

  const upToDate = result !== null && result.key === fetchKey
  const proposal = upToDate ? (result.proposal ?? null) : null
  const failed = upToDate && !!result.failed
  const booked = findPostedVatSettlement(proposal?.existing_entries)
  const draft = findDraftVatSettlement(proposal?.existing_entries)
  const bookingStatus = proposal
    ? vatSettlementBookingStatus(proposal.existing_entries)
    : null

  return { upToDate, proposal, failed, booked, draft, bookingStatus }
}
