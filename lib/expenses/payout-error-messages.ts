/**
 * User-facing Swedish messages for createPayoutBatch refusal codes, shared by
 * POST /api/expense-claims/payouts and POST /api/transactions/[id]/match-expense-payout
 * so the same refusal reads the same on both surfaces.
 */
export const PAYOUT_ERROR_MESSAGES: Record<string, { message: string; status: number }> = {
  NO_CLAIMS: { message: 'Välj minst ett utlägg att betala ut.', status: 400 },
  CLAIMS_NOT_FOUND: { message: 'Något av utläggen hittades inte.', status: 404 },
  ALREADY_PAID: { message: 'Något av utläggen är redan utbetalt.', status: 409 },
  MIXED_CLAIMANTS: {
    message: 'En utbetalning kan bara avse en person. Dela upp per person.',
    status: 400,
  },
  MIXED_LIABILITY: {
    message: 'Utläggen har olika skuldkonton och kan inte betalas ut tillsammans.',
    status: 400,
  },
  FISCAL_PERIOD_NOT_FOUND: {
    message: 'Inget räkenskapsår täcker utbetalningsdatumet.',
    status: 400,
  },
  BATCH_INSERT_FAILED: { message: 'Utbetalningen kunde inte sparas.', status: 500 },
  PERIOD_LOCKED: { message: 'Perioden är låst. Lås upp den innan du bokför utbetalningen.', status: 409 },
  ACCOUNT_NOT_IN_CHART: { message: 'Kontot finns inte i kontoplanen.', status: 400 },
  INVALID_CASH_ACCOUNT: { message: 'Ange ett likvidkonto i 19xx-serien.', status: 400 },
  FORBIDDEN: { message: 'Du saknar behörighet att bokföra utbetalningar i det här företaget.', status: 403 },
  // Bank-line mode (p_transaction_id): the transfer that repays the claims.
  TX_NOT_FOUND: { message: 'Transaktionen hittades inte.', status: 404 },
  TX_ALREADY_BOOKED: { message: 'Transaktionen är redan bokförd.', status: 409 },
  TX_CURRENCY: { message: 'Utlägg betalas ut i SEK och transaktionen har en annan valuta.', status: 400 },
  TX_AMOUNT_MISMATCH: {
    message: 'Beloppet stämmer inte med de valda utläggen. Välj de utlägg som överföringen täcker.',
    status: 400,
  },
}
