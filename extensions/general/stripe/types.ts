/** Row shape of public.stripe_connections. */
export interface StripeConnection {
  id: string
  company_id: string
  user_id: string
  stripe_account_id: string | null
  livemode: boolean
  status: 'pending' | 'active' | 'revoked' | 'error'
  oauth_state: string | null
  display_name: string | null
  last_event_created_at: string | null
  last_event_id: string | null
  error_message: string | null
  connected_at: string | null
  disconnected_at: string | null
  created_at: string
  updated_at: string
}

/** Row shape of public.stripe_payment_events (needs_review projection). */
export interface StripeReviewEvent {
  id: string
  reason: string | null
  amount: number | null
  currency: string | null
  invoice_id: string | null
  event_created_at: string | null
}

/** Status payload returned by GET /api/extensions/ext/stripe/status. */
export interface StripeStatusResponse {
  configured: boolean
  connection: Pick<
    StripeConnection,
    | 'id'
    | 'status'
    | 'stripe_account_id'
    | 'livemode'
    | 'display_name'
    | 'error_message'
    | 'connected_at'
    | 'last_event_created_at'
  > | null
  needs_review_count?: number
  needs_review?: StripeReviewEvent[]
}
