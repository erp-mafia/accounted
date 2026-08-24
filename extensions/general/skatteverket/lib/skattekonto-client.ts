import { skvRequestWithAuth, type SkvAuth } from './api-client'
import type {
  SkatteverketBookedTransaction,
  SkatteverketSaldoResponse,
  SkatteverketTransaktionerResponse,
  SkatteverketUpcomingTransaction,
  SkatteverketFel,
} from '../types'

/**
 * Skatteverket Skattekonto API v2.1.0 client.
 *
 * Spec: https://api.skatteverket.se/beskattning/skattekonto/v2
 * Test: https://api.test.skatteverket.se/beskattning/skattekonto/v2
 *
 * The personal OAuth (BankID) tokens already used for momsdeklaration also
 * grant access to skattekonto when the OAuth scope includes `skattekonto`.
 * skvRequest() handles the gateway headers, rate limiting, and refresh.
 */

const DEFAULT_SKATTEKONTO_BASE_URL =
  'https://api.test.skatteverket.se/beskattning/skattekonto/v2'

export function getSkattekontoBaseUrl(): string {
  return (
    process.env.SKATTEVERKET_SKATTEKONTO_API_BASE_URL ||
    DEFAULT_SKATTEKONTO_BASE_URL
  )
}

/**
 * Map Skatteverket error codes (felkod 1-5) to Swedish user messages.
 *
 * Codes per dev_docs/skattekonto(2.1.0)/examples/felkod_*.json.
 */
function mapFelkodToMessage(fel: SkatteverketFel): string {
  switch (fel.felkod) {
    case 1:
      return 'Felaktigt organisationsnummer.'
    case 2:
      return 'Felaktigt datum.'
    case 3:
      return 'Inget skattekonto är registrerat hos Skatteverket.'
    case 4:
      return 'Internt fel hos Skatteverket. Försök igen om en stund.'
    case 5:
      return 'Skattekontot är stängt.'
    default:
      return fel.felmeddelande || `Skatteverket-fel ${fel.felkod}`
  }
}

/**
 * Throws a typed error with a Swedish message when Skatteverket returns
 * a non-200 response. The skvRequest() helper has already mapped 401/403/429
 * to SkatteverketAuthError, so here we only handle 400/404/500/503 and the
 * felkod envelope returned in the body.
 */
async function handleErrorResponse(response: Response): Promise<never> {
  let fel: SkatteverketFel | null = null
  try {
    fel = (await response.json()) as SkatteverketFel
  } catch {
    // body wasn't JSON: fall through to generic message
  }

  if (fel && typeof fel.felkod === 'number') {
    throw new SkatteverketSkattekontoError(
      mapFelkodToMessage(fel),
      fel.felkod,
      response.status,
    )
  }

  throw new SkatteverketSkattekontoError(
    `Skatteverket svarade med ${response.status}`,
    null,
    response.status,
  )
}

/**
 * Structured error for skattekonto-specific Skatteverket failures.
 * Distinct from SkatteverketAuthError (which signals auth/access/throttle).
 */
export class SkatteverketSkattekontoError extends Error {
  constructor(
    message: string,
    public readonly felkod: number | null,
    public readonly httpStatus: number,
  ) {
    super(message)
    this.name = 'SkatteverketSkattekontoError'
  }
}

/**
 * GET /skattekonton/{omfragad}/saldo
 *
 * @param omfragad 10/12-digit org/personnummer (formatRedovisare format)
 * @param datum    Optional ISO date (YYYY-MM-DD); fetch balance as of date
 */
export async function getSaldo(
  auth: SkvAuth,
  omfragad: string,
  datum?: string,
): Promise<SkatteverketSaldoResponse> {
  const qs = datum ? `?datum=${encodeURIComponent(datum)}` : ''
  const response = await skvRequestWithAuth(
    auth,
    'GET',
    `/skattekonton/${omfragad}/saldo${qs}`,
    undefined,
    { baseUrl: getSkattekontoBaseUrl() },
  )

  if (!response.ok) {
    await handleErrorResponse(response)
  }

  return (await response.json()) as SkatteverketSaldoResponse
}

/**
 * Wire shape of one transaction row in the /transaktioner response.
 *
 * Skatteverket's JSON schema only REQUIRES transaktionsidentitet (tidigare
 * rows), transaktionsdatum, ranteberakningsdatum and transaktionstext. Both
 * belopp fields are optional and are simply omitted when a row carries no
 * amount on that side; observed in prod (issue #1821) where such a row made
 * every sync for the company fail on the NOT NULL belopp_skatteverket
 * column. The domain types promise numbers, so the gap is closed here at
 * the API boundary: nothing downstream may ever see undefined.
 */
interface RawSkattekontoTransaktion {
  transaktionsidentitet?: number | null
  transaktionsdatum: string
  forfallodatum?: string
  ranteberakningsdatum?: string | null
  transaktionstext: string
  beloppSkatteverket?: number | null
  beloppKronofogden?: number | null
}

function toAmount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeBooked(tx: RawSkattekontoTransaktion): SkatteverketBookedTransaction {
  return {
    // Required by SKV's schema on tidigare rows; the cast documents that a
    // violation is SKV breaking its own contract, not a case we invent
    // identities for.
    transaktionsidentitet: tx.transaktionsidentitet as number,
    transaktionsdatum: tx.transaktionsdatum,
    ranteberakningsdatum: tx.ranteberakningsdatum ?? null,
    transaktionstext: tx.transaktionstext,
    // No SKV-side amount means the row did not move money on the
    // Skatteverket side (the amount, if any, lives at Kronofogden): 0 is
    // the truthful value and satisfies the NOT NULL column.
    beloppSkatteverket: toAmount(tx.beloppSkatteverket) ?? 0,
    beloppKronofogden: toAmount(tx.beloppKronofogden),
  }
}

function normalizeUpcoming(tx: RawSkattekontoTransaktion): SkatteverketUpcomingTransaction {
  return {
    transaktionsidentitet: tx.transaktionsidentitet ?? null,
    transaktionsdatum: tx.transaktionsdatum,
    forfallodatum: tx.forfallodatum as string,
    ranteberakningsdatum: tx.ranteberakningsdatum ?? null,
    transaktionstext: tx.transaktionstext,
    beloppSkatteverket: toAmount(tx.beloppSkatteverket) ?? 0,
    beloppKronofogden: toAmount(tx.beloppKronofogden),
  }
}

/**
 * GET /skattekonton/{omfragad}/transaktioner
 *
 * @param omfragad   10/12-digit org/personnummer
 * @param datumFrom  Optional ISO date (YYYY-MM-DD). Defaults at SKV to
 *                   555 days back; max lookback is 915 days.
 */
export async function getTransaktioner(
  auth: SkvAuth,
  omfragad: string,
  datumFrom?: string,
): Promise<SkatteverketTransaktionerResponse> {
  const qs = datumFrom ? `?datumFrom=${encodeURIComponent(datumFrom)}` : ''
  const response = await skvRequestWithAuth(
    auth,
    'GET',
    `/skattekonton/${omfragad}/transaktioner${qs}`,
    undefined,
    { baseUrl: getSkattekontoBaseUrl() },
  )

  if (!response.ok) {
    await handleErrorResponse(response)
  }

  const data = (await response.json()) as {
    tidigareTransaktioner?: RawSkattekontoTransaktion[]
    kommandeTransaktioner?: RawSkattekontoTransaktion[]
  }
  return {
    tidigareTransaktioner: (data.tidigareTransaktioner ?? []).map(normalizeBooked),
    kommandeTransaktioner: (data.kommandeTransaktioner ?? []).map(normalizeUpcoming),
  }
}
