import { skvRequestWithAuth, type SkvAuth } from './api-client'
import type { SkvAuditActor } from './audit'
import type {
  SkatteverketSaldoResponse,
  SkatteverketTransaktionerResponse,
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

const NO_SKATTEKONTO_MESSAGE = 'Inget skattekonto är registrerat hos Skatteverket.'

/**
 * Map Skatteverket error codes (felkod 1-5) to Swedish user messages.
 */
function mapFelkodToMessage(fel: SkatteverketFel): string {
  switch (fel.felkod) {
    case 1:
      return 'Felaktigt organisationsnummer.'
    case 2:
      return 'Felaktigt datum.'
    case 3:
      return NO_SKATTEKONTO_MESSAGE
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

  // A bare 404 ({"message": "Not found"}, no felkod) on /skattekonton/{id}
  // means Skatteverket keeps no skattekonto for that identity yet. Observed
  // in prod on newly formed companies: the same identifier, on the same
  // consent, later answers 200 once Skatteverket has opened the account, so
  // the request is right and the state is Skatteverket's (B07).
  if (response.status === 404) {
    throw new SkatteverketSkattekontoError(NO_SKATTEKONTO_MESSAGE, null, response.status)
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
 * True when Skatteverket answered that it has no skattekonto for the
 * identity: felkod 3, or a bare 404 without a felkod envelope. A state of
 * the account at Skatteverket (typically a company too new to have one),
 * not a failed request: callers record it and show it, they do not log it
 * as an error.
 */
export function isSkattekontoMissing(err: unknown): err is SkatteverketSkattekontoError {
  return (
    err instanceof SkatteverketSkattekontoError &&
    (err.felkod === 3 || (err.felkod === null && err.httpStatus === 404))
  )
}

/**
 * GET /skattekonton/{omfragad}/saldo
 *
 * @param omfragad 10/12-digit org/personnummer (formatRedovisare format)
 * @param actor    Who the audit row names (null user: a system call)
 * @param datum    Optional ISO date (YYYY-MM-DD); fetch balance as of date
 */
export async function getSaldo(
  auth: SkvAuth,
  omfragad: string,
  actor: SkvAuditActor,
  datum?: string,
): Promise<SkatteverketSaldoResponse> {
  const qs = datum ? `?datum=${encodeURIComponent(datum)}` : ''
  const response = await skvRequestWithAuth(
    auth,
    'GET',
    `/skattekonton/${omfragad}/saldo${qs}`,
    { endpoint: 'skattekonto/saldo', ...actor, agRegistreradId: omfragad, expectJson: true },
    undefined,
    { baseUrl: getSkattekontoBaseUrl() },
  )

  if (!response.ok) {
    await handleErrorResponse(response)
  }

  return (await response.json()) as SkatteverketSaldoResponse
}

/**
 * GET /skattekonton/{omfragad}/transaktioner
 *
 * @param omfragad   10/12-digit org/personnummer
 * @param actor      Who the audit row names (null user: a system call)
 * @param datumFrom  Optional ISO date (YYYY-MM-DD). Defaults at SKV to
 *                   555 days back; max lookback is 915 days.
 */
export async function getTransaktioner(
  auth: SkvAuth,
  omfragad: string,
  datumFrom: string | undefined,
  actor: SkvAuditActor,
): Promise<SkatteverketTransaktionerResponse> {
  const qs = datumFrom ? `?datumFrom=${encodeURIComponent(datumFrom)}` : ''
  const response = await skvRequestWithAuth(
    auth,
    'GET',
    `/skattekonton/${omfragad}/transaktioner${qs}`,
    { endpoint: 'skattekonto/transaktioner', ...actor, agRegistreradId: omfragad, expectJson: true },
    undefined,
    { baseUrl: getSkattekontoBaseUrl() },
  )

  if (!response.ok) {
    await handleErrorResponse(response)
  }

  const data = (await response.json()) as Partial<SkatteverketTransaktionerResponse>
  return {
    tidigareTransaktioner: data.tidigareTransaktioner ?? [],
    kommandeTransaktioner: data.kommandeTransaktioner ?? [],
  }
}
