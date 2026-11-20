/**
 * What the minutes (protokoll) say, built from the meeting view. Pure, so
 * the content is tested without rendering. Swedish only.
 *
 * A stämma's minutes state the date and place (or that it was digital), the
 * decisions and, for each vote, the result; the röstlängd is attached as
 * bilaga 1 (ABL 7:48), and the aktiebok as of the meeting day as bilaga 2
 * (7:28: available at the stämma). Board minutes state the decisions and any
 * reservation (8:24) and carry their number (8:26). Signature lines for
 * every signer (rules.ts minutesSigners).
 */
import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import { formatInt, joinNames } from './minutes-text'
import { isStamma } from './rules'
import { CAPACITY_LABELS_SV, MEETING_KIND_LABELS_SV } from './types'
import type { MeetingDetail } from './view'

export interface MinutesCompany {
  name: string
  org_number: string | null
}

export interface MinutesPdfData {
  company: MinutesCompany
  company_line: string
  heading: string
  title: string
  intro: string | null
  meta: Array<{ label: string; value: string }>
  present: string[]
  absent: string[]
  paragraphs: Array<{ number: number; title: string; text: string; votes: string | null; reservations: string | null }>
  signers: Array<{ name: string; role_label: string }>
  closing: string | null
  voting_list: {
    as_of: string
    total_shares: string
    total_votes: string
    present_shares: string
    present_votes: string
    rows: Array<{ name: string; shares: string; votes: string; present: string; proxy: string }>
  } | null
  aktiebok_appendix: boolean
  generated_at: string
}

function votesLine(d: MeetingDetail['decisions'][number]): string | null {
  if (d.votes_for === null && d.votes_against === null && d.votes_abstained === null) return null
  const parts = [
    d.votes_for !== null ? `${formatInt(d.votes_for)} röster för` : null,
    d.votes_against !== null ? `${formatInt(d.votes_against)} emot` : null,
    d.votes_abstained !== null ? `${formatInt(d.votes_abstained)} avstod` : null,
  ].filter(Boolean)
  return `Omröstning: ${parts.join(', ')}. Förslaget ${d.outcome === 'bifallen' ? 'bifölls' : d.outcome === 'avslagen' ? 'avslogs' : 'bordlades'}.`
}

export function buildMinutesPdfData(view: MeetingDetail, company: MinutesCompany, generatedAt: string): MinutesPdfData {
  const companyLine = company.org_number ? `${company.name}, ${formatOrgNumberDisplay(company.org_number)}` : company.name
  const stamma = isStamma(view.kind)
  const perCapsulam = view.kind === 'per_capsulam'
  const body = view.organ === 'styrelse' ? 'styrelsen' : 'aktieägarna'
  const heading = perCapsulam
    ? `Beslut fattade per capsulam av ${body} i ${company.name}`
    : `Protokoll fört vid ${MEETING_KIND_LABELS_SV[view.kind].toLowerCase()} i ${company.name}`
  const meta: MinutesPdfData['meta'] = [{ label: 'Datum', value: view.meeting_time ? `${view.meeting_date} kl. ${view.meeting_time}` : view.meeting_date }]
  if (!perCapsulam) meta.push({ label: 'Plats', value: view.is_digital ? `Digitalt${view.place ? ` (${view.place})` : ''}` : view.place ?? '' })
  if (view.chair && !perCapsulam) meta.push({ label: 'Ordförande', value: view.chair.name })
  if (view.secretary && !perCapsulam) meta.push({ label: 'Protokollförare', value: view.secretary.name })
  if (view.adjusters.length > 0) meta.push({ label: 'Justerare', value: joinNames(view.adjusters.map((a) => a.name)) })

  const present: string[] = []
  const absent: string[] = []
  if (stamma && view.voting_list) {
    present.push(
      `Aktieägare enligt röstlängd, bilaga 1: ${formatInt(view.present?.holders ?? 0)} av ${formatInt(view.voting_list.holders.length)}, ` +
        `företrädande ${formatInt(view.present?.shares ?? 0)} av ${formatInt(view.voting_list.total_shares)} aktier och ${formatInt(view.present?.votes ?? 0)} röster.`,
    )
  }
  for (const a of view.attendees) {
    const line = `${a.name}, ${CAPACITY_LABELS_SV[a.capacity].toLowerCase()}`
    if (a.present) present.push(line)
    else absent.push(line)
  }

  const list = view.voting_list
  return {
    company,
    company_line: companyLine,
    heading,
    title: view.sequence_number ? `Protokoll nr ${view.sequence_number}` : perCapsulam ? 'Beslut per capsulam' : 'Protokoll',
    intro: perCapsulam
      ? view.organ === 'styrelse'
        ? 'Samtliga styrelseledamöter har utan sammanträde fattat följande beslut, som de bekräftar genom att skriva under.'
        : 'Samtliga aktieägare har utan sammanträde fattat följande beslut, som de bekräftar genom att skriva under. Röstlängden är bilaga 1.'
      : null,
    meta,
    present,
    absent,
    paragraphs: view.decisions.map((d) => ({
      number: d.item_number,
      title: d.title,
      text: d.text_rendered,
      votes: votesLine(d),
      reservations: d.reservations ? `Reservation: ${d.reservations}` : null,
    })),
    signers: view.signers.map((s) => ({ name: s.name, role_label: s.role_label })),
    closing: perCapsulam ? null : 'Vid protokollet',
    voting_list: list
      ? {
          as_of: list.as_of,
          total_shares: formatInt(list.total_shares),
          total_votes: formatInt(list.total_votes),
          present_shares: formatInt(view.present?.shares ?? 0),
          present_votes: formatInt(view.present?.votes ?? 0),
          rows: list.holders.map((h) => ({
            name: h.name,
            shares: formatInt(h.shares),
            votes: formatInt(h.votes),
            present: h.present ? 'Ja' : 'Nej',
            proxy: h.proxy_name ?? '',
          })),
        }
      : null,
    aktiebok_appendix: stamma,
    generated_at: generatedAt,
  }
}

/** Protokoll_arsstamma_2027-05-10.pdf, Protokoll_styrelsemote_nr_4_2027-03-01.pdf. */
export function minutesFilename(view: Pick<MeetingDetail, 'kind' | 'sequence_number' | 'meeting_date'>): string {
  const kind = { arsstamma: 'arsstamma', extra_stamma: 'extra_stamma', styrelsemote: 'styrelsemote', per_capsulam: 'per_capsulam' }[view.kind]
  return `Protokoll_${kind}${view.sequence_number ? `_nr_${view.sequence_number}` : ''}_${view.meeting_date}.pdf`
}
