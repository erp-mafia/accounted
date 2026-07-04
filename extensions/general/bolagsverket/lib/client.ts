/**
 * Typed HTTP client for Bolagsverket's digital-inlämning REST services.
 *
 * Environments + endpoints per Anslutningsanvisning v1.7 §3:
 *   - test    → https://api-accept2.bolagsverket.se/testapi/…   (no client cert;
 *               static data, orgnr 1234567890/1234567891; requires firewall
 *               opening ordered via api@bolagsverket.se)
 *   - accept  → https://api-accept2.bolagsverket.se/…           (mTLS)
 *   - prod    → https://api.bolagsverket.se/…                   (mTLS)
 *
 * mTLS uses an Expisoft/Steria organisationscertifikat whose SERIALNUMBER is
 * `16` + the supplier's 10-digit orgnr (ANSLUTNINGSANVISNING §5.3). Cert/key
 * come from env vars ONLY (BOLAGSVERKET_CLIENT_CERT/_KEY/_CA): never from
 * extension settings; extension_data is readable by every company member, so
 * private-key material must not be stored there. Implemented with node:https
 * (undici fetch has no portable client-cert support inside Next.js route
 * handlers).
 */

import { request as httpsRequest, type RequestOptions } from 'node:https'
import { URL } from 'node:url'
import type { ZodType } from 'zod'
import {
  InlamningSvarSchema,
  InlamningTokenSvarSchema,
  KontrolleraSvarSchema,
  KontrollsummaSvarSchema,
} from './schemas'
import type {
  ArendestatusSvar,
  BolagsverketEnvironment,
  GrunduppgifterSvar,
  HamtaHandelserSvar,
  HandlingTyp,
  InlamningSvar,
  InlamningTokenSvar,
  KontrolleraSvar,
  KontrollsummaSvar,
} from '../types'

export const BOLAGSVERKET_ENVIRONMENTS = ['test', 'accept', 'prod'] as const

export function isBolagsverketEnvironment(value: unknown): value is BolagsverketEnvironment {
  return (
    typeof value === 'string' &&
    (BOLAGSVERKET_ENVIRONMENTS as readonly string[]).includes(value)
  )
}

const HOSTS: Record<BolagsverketEnvironment, { base: string; prefix: string }> = {
  test: { base: 'https://api-accept2.bolagsverket.se', prefix: '/testapi' },
  accept: { base: 'https://api-accept2.bolagsverket.se', prefix: '' },
  prod: { base: 'https://api.bolagsverket.se', prefix: '' },
}

/** API felkoder (GUIDE Appendix A §6.2) → user-facing Swedish messages. */
export const BOLAGSVERKET_ERROR_MESSAGES: Record<string, string> = {
  '4001': 'Dokumentet är inte en giltig iXBRL-fil.',
  '4002': 'Programvaruversionen stöds inte längre av Bolagsverkets tjänst.',
  '4003': 'Ogiltigt organisationsnummer.',
  '4004': 'Organisationsnumret avser inte ett aktiebolag.',
  '4005': 'Ingen träff på organisationsnumret hos Bolagsverket.',
  '4007': 'Ogiltigt personnummer.',
  '4008': 'Filen innehåller ett eller flera tekniska fel.',
  '4010': 'Årsredovisningen är upprättad i en taxonomiversion som Bolagsverket inte längre stödjer.',
  '4011': 'Tjänsten stödjer inte den här företagsformen.',
  '5001': 'Dokumentet saknar eller har tom title-tagg.',
  '5002': 'Dokumentet är inte en iXBRL-fil.',
  '5006': 'Dokumentet överstiger tillåten maxstorlek (5 MB).',
  '5008': 'Dokumentet är inte kodat i UTF-8.',
  '5009': 'Dokumentet saknar taggning av programvara och/eller programversion.',
  '7003': 'Felaktig token: skapa en ny inlämningstoken och försök igen.',
  '7004': 'Dokumentet innehåller skadlig kod.',
  '7006': 'Årsredovisningen kan inte skickas in eftersom företaget är avvecklat.',
  '7007': 'Tjänsten stödjer inte digital inlämning för den här företagsformen.',
  '9003': 'Icke godkänd användare av tjänsten: kontrollera certifikat och avtal med Bolagsverket.',
}

export class BolagsverketApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message)
    this.name = 'BolagsverketApiError'
  }
}

export interface BolagsverketClientConfig {
  environment: BolagsverketEnvironment
  /** PEM strings: required for accept/prod, ignored for test. */
  clientCertPem?: string | null
  clientKeyPem?: string | null
  /** Extra CA chain (TeliaSonera root is normally in the system store). */
  caPem?: string | null
  /** Socket inactivity timeout. */
  timeoutMs?: number
  /** Overall per-request deadline (covers slow trickling bodies too). */
  deadlineMs?: number
}

/**
 * Resolve config from env vars; the extension may override the environment
 * per install (validated + capped against BOLAGSVERKET_ENV in index.ts).
 * Certificate material is ENV-ONLY: never read from extension settings.
 */
export function configFromEnv(
  overrides: Partial<BolagsverketClientConfig> = {},
): BolagsverketClientConfig {
  const rawEnvironment = overrides.environment ?? process.env.BOLAGSVERKET_ENV ?? 'test'
  if (!isBolagsverketEnvironment(rawEnvironment)) {
    // Fail fast with a clear message instead of HOSTS[env] → opaque TypeError.
    throw new BolagsverketApiError(
      `Ogiltig Bolagsverket-miljö '${String(rawEnvironment)}', tillåtna värden: ${BOLAGSVERKET_ENVIRONMENTS.join(', ')}.`,
      0,
      '',
    )
  }
  const environment = rawEnvironment
  const decode = (value: string | undefined | null): string | null => {
    if (!value) return null
    // Allow base64-wrapped PEM in env vars (newline-hostile platforms).
    return value.includes('-----BEGIN')
      ? value
      : Buffer.from(value, 'base64').toString('utf8')
  }
  return {
    environment,
    clientCertPem: overrides.clientCertPem ?? decode(process.env.BOLAGSVERKET_CLIENT_CERT),
    clientKeyPem: overrides.clientKeyPem ?? decode(process.env.BOLAGSVERKET_CLIENT_KEY),
    caPem: overrides.caPem ?? decode(process.env.BOLAGSVERKET_CA),
    timeoutMs: overrides.timeoutMs ?? 30_000,
    deadlineMs: overrides.deadlineMs ?? 90_000,
  }
}

interface HttpResponse {
  status: number
  body: string
}

function rawRequest(
  config: BolagsverketClientConfig,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  jsonBody?: unknown,
): Promise<HttpResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url)
    const payload = jsonBody === undefined ? null : JSON.stringify(jsonBody)
    const options: RequestOptions = {
      method,
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: config.timeoutMs ?? 30_000,
    }
    // mTLS for accept/prod (the test env is plain TLS behind a firewall).
    if (config.environment !== 'test') {
      if (!config.clientCertPem || !config.clientKeyPem) {
        rejectPromise(
          new BolagsverketApiError(
            'Organisationscertifikat saknas: miljövariablerna BOLAGSVERKET_CLIENT_CERT/BOLAGSVERKET_CLIENT_KEY krävs för acceptans- och produktionsmiljön.',
            0,
            '',
          ),
        )
        return
      }
      options.cert = config.clientCertPem
      options.key = config.clientKeyPem
      if (config.caPem) options.ca = config.caPem
    }
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      fn()
    }
    // Overall deadline: the socket-inactivity `timeout` above never fires for
    // a server that trickles bytes forever: destroy the request outright.
    const deadline = setTimeout(() => {
      req.destroy(new Error('tidsgränsen för hela anropet överskreds'))
    }, config.deadlineMs ?? 90_000)
    const req = httpsRequest(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        settle(() =>
          resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
      })
      // Mid-body connection failure: without this the promise never settles
      // (the request-level 'error' handler does not fire once headers landed).
      res.on('error', (err: Error) => {
        settle(() =>
          rejectPromise(
            new BolagsverketApiError(
              `Anslutningen till Bolagsverket bröts mitt i svaret (${err.message}). Försök igen.`,
              0,
              '',
            ),
          ),
        )
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', (err) => {
      settle(() =>
        rejectPromise(
          new BolagsverketApiError(
            `Kunde inte nå Bolagsverket (${err.message}). Kontrollera brandväggsöppning och certifikat.`,
            0,
            '',
          ),
        ),
      )
    })
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * Pull a felkod out of an error body. Error bodies carry "NNNN=text" lines or
 * {"felkod":"NNNN", ...}-style JSON (GUIDE Appendix A §6.2). Anchored to those
 * two shapes: a bare \bNNNN\b match would false-positive on years and other
 * four-digit numbers inside prose.
 */
export function extractFelkod(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (parsed && typeof parsed === 'object') {
      for (const field of ['felkod', 'kod']) {
        const value = parsed[field]
        const asString = typeof value === 'number' ? String(value) : value
        if (typeof asString === 'string' && /^[4579]\d{3}$/.test(asString)) return asString
      }
    }
  } catch {
    // not JSON: fall through to the "NNNN=text" shape
  }
  const match = body.match(/(?:^|[\r\n])\s*([4579]\d{3})\s*=/)
  return match ? match[1] : null
}

function mapError(status: number, body: string): BolagsverketApiError {
  const felkod = extractFelkod(body)
  const known = felkod ? BOLAGSVERKET_ERROR_MESSAGES[felkod] : null
  const fallback =
    status === 404
      ? 'Ingen träff hos Bolagsverket (404).'
      : status === 503 || status === 504
        ? 'Bolagsverkets tjänst är tillfälligt otillgänglig: försök igen om en stund.'
        : `Bolagsverket svarade med fel (HTTP ${status}).`
  return new BolagsverketApiError(known ?? fallback, status, body.slice(0, 2_000))
}

interface RequestJsonOptions {
  /**
   * Validate the response shape at the boundary (Zod). Schemas are loose
   * (passthrough) and only pin the fields downstream code dereferences, so
   * the parsed value is returned as the caller's declared DTO type.
   */
  schema?: ZodType<unknown>
  /** Human-readable endpoint name for error messages. */
  endpoint?: string
}

async function requestJson<T>(
  config: BolagsverketClientConfig,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  jsonBody?: unknown,
  options: RequestJsonOptions = {},
): Promise<T> {
  let res = await rawRequest(config, method, url, jsonBody)
  // One retry for idempotent GETs when the service is momentarily unavailable.
  if (method === 'GET' && (res.status === 503 || res.status === 504)) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    res = await rawRequest(config, method, url, jsonBody)
  }
  if (res.status < 200 || res.status >= 300) throw mapError(res.status, res.body)
  if (res.body.trim().length === 0) return undefined as T
  let parsed: unknown
  try {
    parsed = JSON.parse(res.body)
  } catch {
    throw new BolagsverketApiError('Oväntat svar från Bolagsverket (inte JSON).', res.status, res.body.slice(0, 500))
  }
  if (options.schema) {
    const result = options.schema.safeParse(parsed)
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      throw new BolagsverketApiError(
        `Oväntat svarsformat från Bolagsverket (${options.endpoint ?? url}): ${issues}`,
        res.status,
        res.body.slice(0, 500),
      )
    }
    return result.data as T
  }
  return parsed as T
}

export class BolagsverketClient {
  constructor(private readonly config: BolagsverketClientConfig) {}

  get environment(): BolagsverketEnvironment {
    return this.config.environment
  }

  private url(service: string, path: string): string {
    const { base, prefix } = HOSTS[this.config.environment]
    return `${base}${prefix}/${service}${path}`
  }

  // ---- informationstjänster (GUIDE §5.2) ----------------------------------

  getGrunduppgifter(orgnr: string): Promise<GrunduppgifterSvar> {
    return requestJson(this.config, 'GET', this.url('hamta-arsredovisningsinformation/v1.4', `/grunduppgifter/${encodeURIComponent(orgnr)}`))
  }

  getArendestatus(orgnr: string): Promise<ArendestatusSvar> {
    return requestJson(this.config, 'GET', this.url('hamta-arsredovisningsinformation/v1.4', `/arendestatus/${encodeURIComponent(orgnr)}`))
  }

  /** Token for skapa-kontrollsumma (information service, v1.1). */
  createChecksumToken(pnr: string, orgnr: string): Promise<InlamningTokenSvar> {
    return requestJson(this.config, 'POST', this.url('hamta-arsredovisningsinformation/v1.1', '/skapa-inlamningtoken/'), { pnr, orgnr }, {
      schema: InlamningTokenSvarSchema,
      endpoint: 'skapa-inlamningtoken (kontrollsumma)',
    })
  }

  createChecksum(token: string, fileBase64: string): Promise<KontrollsummaSvar> {
    return requestJson(this.config, 'POST', this.url('hamta-arsredovisningsinformation/v1.1', `/skapa-kontrollsumma/${encodeURIComponent(token)}`), { fil: fileBase64 }, {
      schema: KontrollsummaSvarSchema,
      endpoint: 'skapa-kontrollsumma',
    })
  }

  // ---- inlämning (GUIDE §5.3) ----------------------------------------------

  createInlamningToken(pnr: string, orgnr: string): Promise<InlamningTokenSvar> {
    return requestJson(this.config, 'POST', this.url('lamna-in-arsredovisning/v2.1', '/skapa-inlamningtoken/'), { pnr, orgnr }, {
      schema: InlamningTokenSvarSchema,
      endpoint: 'skapa-inlamningtoken',
    })
  }

  kontrollera(token: string, fileBase64: string, typ: HandlingTyp): Promise<KontrolleraSvar> {
    return requestJson(this.config, 'POST', this.url('lamna-in-arsredovisning/v2.1', `/kontrollera/${encodeURIComponent(token)}`), {
      handling: { fil: fileBase64, typ },
    }, {
      schema: KontrolleraSvarSchema,
      endpoint: 'kontrollera',
    })
  }

  lamnaIn(
    token: string,
    body: {
      undertecknare: string
      epostadresser: string[]
      kvittensepostadresser?: string[]
      notifieringEpostadresser?: string[]
      fileBase64: string
      typ: HandlingTyp
    },
  ): Promise<InlamningSvar> {
    return requestJson(this.config, 'POST', this.url('lamna-in-arsredovisning/v2.1', `/inlamning/${encodeURIComponent(token)}`), {
      undertecknare: body.undertecknare,
      epostadresser: body.epostadresser,
      ...(body.kvittensepostadresser?.length ? { kvittensepostadresser: body.kvittensepostadresser } : {}),
      ...(body.notifieringEpostadresser?.length ? { notifieringEpostadresser: body.notifieringEpostadresser } : {}),
      handling: { fil: body.fileBase64, typ: body.typ },
    }, {
      schema: InlamningSvarSchema,
      endpoint: 'inlamning',
    })
  }

  // ---- händelser (GUIDE §5.4) ----------------------------------------------

  /** Idempotent: existing (url, orgnr) pair gets its TTL extended 6 months. */
  async createSubscription(url: string, orgnr: string, auth: string): Promise<void> {
    await requestJson(this.config, 'POST', this.url('hantera-arsredovisningsprenumerationer/v2.0', '/handelseprenumeration/'), {
      prenumerationer: [{ url, orgnr, auth }],
    })
  }

  async deleteSubscription(url: string, orgnr: string): Promise<void> {
    await requestJson(this.config, 'DELETE', this.url('hantera-arsredovisningsprenumerationer/v2.0', '/handelseprenumeration/'), { url, orgnr })
  }

  /** Polling fallback for missed webhooks (events kept ~1 year). */
  hamtaHandelser(body: {
    url: string
    orgnr: string[]
    fromtidpunkt?: string
    tomtidpunkt?: string
  }): Promise<HamtaHandelserSvar> {
    return requestJson(this.config, 'POST', this.url('hamta-arsredovisningshandelser/v2.0', '/handelser/'), body)
  }
}
