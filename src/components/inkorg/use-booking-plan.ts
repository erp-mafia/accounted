'use client'

import { useEffect, useState } from 'react'
import type { OneClickPlan } from '@/lib/operations/inkorg-one-click'
import type { SellerRegion } from '@/lib/vat/seller-country'

/** What GET /api/inkorg/items/:id/booking-plan answers. */
export interface BookingPlan {
  plan: OneClickPlan
  preview_token: string
}

/** What the person answered on the page, sent with the plan's read and with the booking. */
export interface OneClickAnswers {
  purchase_category?: string
  seller_country?: SellerRegion
}

/** The body of POST /api/inkorg/items/:id/book. */
export interface OneClickBooking extends OneClickAnswers {
  preview_token: string
  transaction_id?: string
}

export const BOOKING_PLAN_URL = (id: string) => `/api/inkorg/items/${id}/booking-plan`
export const BOOK_URL = (id: string) => `/api/inkorg/items/${id}/book`

/**
 * The item's booking plan: what one click books, or what to ask first. Read
 * once per `key` (the item, its revision, the answers), only while
 * `wanted`. No plan is not the person's doing: the answers then open the
 * editors as they always did.
 */
export function useBookingPlan(itemId: string, wanted: boolean, key: string, answers: OneClickAnswers): BookingPlan | null {
  const query = new URLSearchParams(
    Object.entries(answers).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''),
  ).toString()
  const readKey = wanted ? `${key}?${query}` : null
  const [answer, setAnswer] = useState<{ key: string; plan: BookingPlan | null } | null>(null)

  useEffect(() => {
    if (!readKey) return
    const controller = new AbortController()
    fetch(`${BOOKING_PLAN_URL(itemId)}${query ? `?${query}` : ''}`, { signal: controller.signal })
      .then(async (res) => {
        const json = res.ok ? ((await res.json()) as { data?: BookingPlan }) : null
        setAnswer({ key: readKey, plan: json?.data ?? null })
      })
      .catch(() => {
        if (!controller.signal.aborted) setAnswer({ key: readKey, plan: null })
      })
    return () => controller.abort()
    // The key carries the item, its revision and the answers (the query).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readKey])

  return readKey && answer?.key === readKey ? answer.plan : null
}
