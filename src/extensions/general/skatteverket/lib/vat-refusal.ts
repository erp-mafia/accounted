/**
 * The one reader of a refused Momsdeklaration call (crm#1866).
 *
 * Skatteverket answers a refused call in the shapes its API description
 * gives (momsdeklaration 1.0.24, traits/responses/errors):
 *
 *   - its own envelope { kod, meddelandeTillAnvandare, meddelandeTillUtvecklare }:
 *     kod repeats the HTTP status, and either message can be null;
 *   - the gateway's { message } when the request never reached the service,
 *     naming the value it refuses by its path ("/momsuppgift/x expected ...");
 *   - something else, or nothing.
 *
 * Every call used to glue the status to the body text, so the person and the
 * agent read a string of JSON, and an envelope with both messages null read
 * as no reason at all. Here the answer becomes Swedish sentences (what
 * Skatteverket said, verbatim where it said something, the declaration boxes
 * it names by our name for them, and what to do next) plus the same answer
 * in fields, for the MCP answer and the stored operation.
 *
 * Nothing here decides what is sent: it only reads what came back.
 */
import { BOX_LABELS, type MomsBox } from '@/lib/vat/moms-box-mapping'
import { maskPersonnummerInText } from '@/lib/salary/personnummer-format'
import type { SkatteverketKontroll, SkatteverketKontrollResultat } from '../types'
import { MOMSUPPGIFT_FIELD_BY_RUTA } from './mappers'

/** The call that was refused. */
export type VatRefusalStep = 'validate' | 'draft' | 'draft_read' | 'draft_delete' | 'lock' | 'unlock'

/** A declaration box Skatteverket's answer names. */
export interface VatRefusalBox {
  ruta: MomsBox
  label: string
}

export interface VatRefusalDetails {
  skv_step: VatRefusalStep
  /** Skatteverket's HTTP status. */
  skv_status: number
  /** `kod` from Skatteverket's envelope, when it sent one. */
  skv_kod?: number | string
  /** meddelandeTillAnvandare, verbatim. Absent when Skatteverket sent none. */
  skv_user_message?: string
  /** meddelandeTillUtvecklare, verbatim. */
  skv_developer_message?: string
  /** The gateway's own `message` or `error`, verbatim. */
  skv_gateway_message?: string
  /** The declaration boxes the answer names. */
  skv_rutor?: VatRefusalBox[]
  /** The body as sent, cut, when it held something none of the fields above carry. */
  skv_body?: string
}

export interface VatRefusal {
  /** Skatteverket's HTTP status. */
  status: number
  /** Swedish, for the person: what Skatteverket answered and what to do next. */
  message: string
  details: VatRefusalDetails
}

const REFUSED: Record<VatRefusalStep, string> = {
  validate: 'Skatteverket tog inte emot deklarationen för kontroll',
  draft: 'Skatteverket tog inte emot utkastet',
  draft_read: 'Skatteverket lämnade inte ut utkastet',
  draft_delete: 'Skatteverket raderade inte utkastet',
  lock: 'Skatteverket låste inte utkastet för signering',
  unlock: 'Skatteverket låste inte upp utkastet',
}

/** The steps on the way to a filed declaration: only they are told where else it can be filed. */
const FILING_STEPS: ReadonlySet<VatRefusalStep> = new Set<VatRefusalStep>(['validate', 'draft', 'lock'])

/** The text fields of the two envelopes the API description gives. */
const TEXT_KEYS: ReadonlySet<string> = new Set(['meddelandeTillAnvandare', 'meddelandeTillUtvecklare', 'message', 'error'])

/**
 * Whether a field of the body is one the sentence and the details already
 * carry: kod, a text field that held text, a kontrollresultat. Anything else
 * with a value is something the API description does not give.
 */
function isRead(key: string, value: unknown): boolean {
  if (value === null || value === '') return true
  if (key === 'kod') return typeof value === 'number' || typeof value === 'string'
  if (key === 'kontrollResultat') return typeof value === 'object'
  return TEXT_KEYS.has(key) && typeof value === 'string'
}

const QUOTE_MAX = 300
const BODY_MAX = 500
const KONTROLL_MAX = 5

/** Momsuppgift field (as Skatteverket's schema names it) to its box. */
const BOX_BY_FIELD: ReadonlyMap<string, MomsBox> = new Map<string, MomsBox>(
  Object.entries(MOMSUPPGIFT_FIELD_BY_RUTA).map(([ruta, field]): [string, MomsBox] => [
    field,
    ruta.slice('ruta'.length) as MomsBox,
  ]),
)

/**
 * One matcher per field. A camelCase name is no word of any language, so it
 * counts wherever it stands; a one-word name ("import", "vinstmarginal") only
 * as a path segment or a quoted property, the way the gateway writes it.
 */
const FIELD_MATCHERS: ReadonlyArray<{ box: MomsBox; pattern: RegExp }> = [...BOX_BY_FIELD].map(([field, box]) => ({
  box,
  pattern: new RegExp(`${/[A-Z]/.test(field) ? '(?<![A-Za-z0-9])' : '(?<=[/"\'.\\[])'}${field}(?![A-Za-z0-9])`),
}))

/** "fält 49", "ruta 49": the way Skatteverket's own sentences point at a box. */
const BOX_NUMBER_IN_TEXT = /(?:fält|ruta)\s+(\d{2})(?!\d)/gi

function isBox(value: string): value is MomsBox {
  return Object.hasOwn(BOX_LABELS, value)
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** A non-empty string from Skatteverket, with any personnummer in it masked. */
function said(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text ? maskPersonnummerInText(text) : undefined
}

function asSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

function listSv(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} och ${items[items.length - 1]}`
}

function boxesNamedIn(texts: Array<string | undefined>): VatRefusalBox[] {
  const found = new Set<MomsBox>()
  for (const text of texts) {
    if (!text) continue
    for (const { box, pattern } of FIELD_MATCHERS) if (pattern.test(text)) found.add(box)
    for (const match of text.matchAll(BOX_NUMBER_IN_TEXT)) if (isBox(match[1])) found.add(match[1])
  }
  return [...found].sort().map((ruta) => ({ ruta, label: BOX_LABELS[ruta] }))
}

function kontrollErrors(kontrollresultat: unknown): SkatteverketKontroll[] {
  const resultat = (kontrollresultat as SkatteverketKontrollResultat | null | undefined)?.resultat
  return Array.isArray(resultat) ? resultat.filter((k) => k?.status === 'ERROR') : []
}

/**
 * Skatteverket's ERROR findings as one sentence. A `kod` that is a box number
 * gets our name for the box; any other kod is written as Skatteverket sent it.
 * Null when there are none.
 */
export function describeKontrollErrors(kontrollresultat: unknown): string | null {
  const errors = kontrollErrors(kontrollresultat)
  if (errors.length === 0) return null
  const shown = errors.slice(0, KONTROLL_MAX).map((k) => {
    const kod = typeof k.kod === 'string' ? k.kod.trim() : ''
    const text = said(k.beskrivning) ?? ''
    const where = isBox(kod) ? `ruta ${kod} (${BOX_LABELS[kod]})` : kod
    return [where, text].filter(Boolean).join(': ').replace(/[.\s]+$/, '')
  })
  const hidden = errors.length - shown.length
  return `Skatteverkets kontroll visade ${errors.length} fel: ${shown.join('; ')}${hidden > 0 ? ` (och ${hidden} till)` : ''}.`
}

/**
 * What a person reads when Skatteverket's own service is failing: nothing is
 * wrong with what was sent. One sentence for every declaration's door.
 */
export const SKV_SERVICE_FAILING_SV = 'Skatteverkets tjänst har ett tekniskt fel just nu. Försök igen om en stund.'

function nextStep(step: VatRefusalStep, status: number): string {
  if (status >= 500) return SKV_SERVICE_FAILING_SV
  if (status === 409 && (step === 'draft' || step === 'draft_delete')) {
    return 'Det finns redan ett utkast som är låst för signering hos Skatteverket. Signera det där, eller lås upp det under Fler åtgärder på momsdeklarationen och skicka igen.'
  }
  if (status === 404 && (step === 'validate' || step === 'draft')) {
    return 'Kontrollera att företagets organisationsnummer och momsperiod (månad, kvartal eller år) stämmer med det Skatteverket har registrerat.'
  }
  return FILING_STEPS.has(step)
    ? 'Försök igen om en stund. Går det fortfarande inte kan deklarationen lämnas direkt i Skatteverkets e-tjänst.'
    : 'Försök igen om en stund.'
}

/**
 * Read a refused response of the Momsdeklaration API. `context.kontrollresultat`
 * is the findings of the step before (the saved draft's, when the lock is
 * refused): they are named when the refused answer carries none of its own.
 */
export async function readVatRefusal(
  response: Response,
  step: VatRefusalStep,
  context: { kontrollresultat?: SkatteverketKontrollResultat | null } = {},
): Promise<VatRefusal> {
  const status = response.status
  const raw = (await response.text().catch(() => '')).trim()

  let body: Record<string, unknown> | null = null
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // Not JSON (a gateway's plain text or error page): read as text below.
    }
  }

  const user = said(body?.meddelandeTillAnvandare)
  const developer = said(body?.meddelandeTillUtvecklare)
  const gateway = said(body?.message) ?? said(body?.error)
  const rawKod = body?.kod
  const kod = typeof rawKod === 'number' ? rawKod : said(rawKod)
  const kontroll = describeKontrollErrors(body?.kontrollResultat) ?? describeKontrollErrors(context.kontrollresultat)

  // What the body held beyond the fields read above: a shape the API
  // description does not give, or no JSON at all. Quoted as it came, unless
  // it is markup (an error page), which is no sentence for anyone.
  const unread = body === null ? raw !== '' : Object.entries(body).some(([key, value]) => !isRead(key, value))
  const excerpt = unread ? cut(maskPersonnummerInText(raw), BODY_MAX) : undefined
  const quotable = excerpt !== undefined && !/<[a-z!/]/i.test(excerpt) ? cut(excerpt, QUOTE_MAX) : undefined

  const rutor = boxesNamedIn([user, developer, gateway, excerpt])

  const lead = REFUSED[step]
  const sentences: string[] = []
  if (user) sentences.push(`${lead}: ${asSentence(user)}`)
  else if (developer) sentences.push(`${lead}: ${asSentence(developer)}`)
  else if (gateway) sentences.push(`${lead}. Skatteverkets svar: "${gateway}".`)
  else if (quotable) sentences.push(`${lead}. Skatteverkets svar: "${quotable}".`)
  else if (kontroll) sentences.push(`${lead}.`)
  else sentences.push(`${lead} och angav ingen orsak (svarskod ${status}).`)
  if (user && developer && developer !== user) sentences.push(`Skatteverkets detalj: ${asSentence(developer)}`)
  if (kontroll) sentences.push(kontroll)
  if (rutor.length > 0) {
    sentences.push(`Det gäller ${listSv(rutor.map((box) => `ruta ${box.ruta} (${box.label})`))}.`)
  }
  sentences.push(nextStep(step, status))

  return {
    status,
    message: sentences.join(' '),
    details: {
      skv_step: step,
      skv_status: status,
      ...(kod !== undefined ? { skv_kod: kod } : {}),
      ...(user ? { skv_user_message: user } : {}),
      ...(developer ? { skv_developer_message: developer } : {}),
      ...(gateway ? { skv_gateway_message: gateway } : {}),
      ...(rutor.length > 0 ? { skv_rutor: rutor } : {}),
      ...(excerpt ? { skv_body: excerpt } : {}),
    },
  }
}
