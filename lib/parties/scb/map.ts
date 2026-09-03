/**
 * From SCB's Je layout to party facts. Codes come from "Variabelbeskrivning
 * API" (SCB:s allmänna företagsregister, 28 pages, saved in
 * dev_docs/scb_docs); labels are Swedish because the dossier shows them as
 * they are and the register is Swedish by nature.
 */

export interface ScbFact {
  field: string
  value: unknown
  reference?: Record<string, unknown>
  valid_from?: string
}

const F_SKATT: Record<string, string> = {
  '0': 'Har aldrig varit registrerat för F-skatt',
  '1': 'Godkänd för F-skatt',
  '9': 'Avregistrerad för F-skatt',
}
const MOMS: Record<string, string> = {
  '0': 'Har aldrig varit registrerat för moms',
  '1': 'Momsregistrerad',
  '3': 'Momsregistrerad via representant',
  '9': 'Avregistrerad för moms',
}
const ARBETSGIVARE: Record<string, string> = {
  '0': 'Har aldrig varit registrerad som arbetsgivare',
  '1': 'Registrerad som arbetsgivare',
  '2': 'Registrerad som privatarbetsgivare',
  '3': 'Registrerad som arbetsgivare via representant',
  '4': 'Registrerad som ambassad eller konsulat',
  '9': 'Avregistrerad som arbetsgivare',
}
const FORETAGSSTATUS: Record<string, string> = {
  '0': 'Har aldrig varit verksamt',
  '1': 'Verksamt',
  '9': 'Ej verksamt',
}
export const JURIDISK_FORM: Record<string, string> = {
  '10': 'Fysisk person',
  '21': 'Enkelt bolag',
  '22': 'Partrederi',
  '23': 'Värdepappersfond',
  '31': 'Handelsbolag eller kommanditbolag',
  '32': 'Gruvbolag',
  '41': 'Bankaktiebolag',
  '42': 'Försäkringsaktiebolag',
  '43': 'Europabolag',
  '49': 'Aktiebolag',
  '51': 'Ekonomisk förening',
  '53': 'Bostadsrättsförening',
  '54': 'Kooperativ hyresrättsförening',
  '55': 'Europakooperativ',
  '61': 'Ideell förening',
  '62': 'Samfällighet',
  '63': 'Registrerat trossamfund',
  '71': 'Familjestiftelse',
  '72': 'Stiftelse eller fond',
  '81': 'Statlig enhet',
  '82': 'Kommun',
  '83': 'Kommunalförbund',
  '84': 'Region',
  '85': 'Allmän försäkringskassa',
  '87': 'Offentlig korporation eller anstalt',
  '88': 'Hypoteksförening',
  '89': 'Regional statlig myndighet',
  '91': 'Oskiftat dödsbo',
  '92': 'Ömsesidigt försäkringsbolag',
  '93': 'Sparbank',
  '94': 'Understöds- eller försäkringsförening',
  '95': 'Arbetslöshetskassa',
  '96': 'Utländsk juridisk person',
  '98': 'Övrig svensk juridisk person',
  '99': 'Juridisk form ej utredd',
}
const BOLAGSVERKET_STATUS: Record<string, string> = {
  '0': 'Normalläge',
  '11': 'Ackordsförhandling inledd',
  '12': 'Ackordsförhandling upphör',
  '13': 'Ackordsförhandling upphävd av domstol',
  '20': 'Konkurs inledd',
  '21': 'Konkurs avslutad',
  '22': 'Konkurs avslutad med överskott',
  '24': 'Konkurs upphävd av rätt',
  '31': 'Likvidation avslutad',
  '32': 'Likvidation beslutad',
  '33': 'Likvidation fortsätter',
  '34': 'Likvidation upphör, verksamheten återupptas',
  '35': 'Likvidation upphävd av domstol',
  '36': 'Bolaget avfört enligt 13 kap 18 § ABL',
  '37': 'Bolaget är avfört',
  '40': 'Fusion inledd',
  '41': 'Upplöst genom fusion',
  '45': 'Fusion tillåten',
  '49': 'Fusion pågår',
  '50': 'Avförd enligt 17 § handelsregisterlagen',
  '51': 'Avförd',
  '52': 'Avregistrerad',
  '53': 'Avregistrerad på grund av ny innehavare',
  '54': 'Avförd på grund av fusion med utländskt företag',
  '60': 'Avförd på grund av utländskt företags likvidation eller konkurs',
  '61': 'Avförd, verksamheten har upphört',
  '62': 'Avförd, filialen saknar verkställande direktör',
  '63': 'Avförd enligt domstolsbeslut',
  '64': 'Avförd, årsredovisning saknas',
  '70': 'Bolaget avfört på egen begäran',
  '71': 'Bolaget avfört av Bolagsverket',
  '73': 'Avförd',
  '74': 'Avförd, omregistrerat till bankaktiebolag',
  '75': 'Beslut om ombildning',
  '76': 'Tillstånd till ombildning',
  '77': 'Avregistrerad på grund av ombildning',
  '78': 'Ombildning förfallen',
  '80': 'Företagsrekonstruktion inledd',
  '81': 'Företagsrekonstruktion upphörd',
  '82': 'Företagsrekonstruktion upphävd av domstol',
  '85': 'Resolution inledd',
  '86': 'Resolution avslutad',
  '87': 'Resolution upphävd',
  '90': 'Delning pågår',
  '91': 'Upplöst genom delning',
  '99': 'Övertagande av annat bolag pågår',
}
const STORLEKSKLASS: Record<string, string> = {
  '0': 'Uppgift saknas',
  '1': '0 anställda',
  '2': '1 till 4 anställda',
  '3': '5 till 9 anställda',
  '4': '10 till 19 anställda',
  '5': '20 till 49 anställda',
  '6': '50 till 99 anställda',
  '7': '100 till 199 anställda',
  '8': '200 till 499 anställda',
  '9': '500 till 999 anställda',
  '10': '1 000 till 1 499 anställda',
  '11': '1 500 till 1 999 anställda',
  '12': '2 000 till 2 999 anställda',
  '13': '3 000 till 3 999 anställda',
  '14': '4 000 till 4 999 anställda',
  '15': '5 000 till 9 999 anställda',
  '16': '10 000 anställda eller fler',
}

/** Which Bolagsverket statuses mean "do not treat this as a going concern". */
export const BOLAGSVERKET_WARNING_CODES = new Set(['11', '12', '13', '20', '32', '33', '36', '37', '40', '41', '49', '50', '51', '52', '53', '54', '60', '61', '62', '63', '64', '70', '71', '73', '80', '85', '90', '91'])

/**
 * A company row as the API returns it. Keys are SCB's variable names; the
 * exact spelling is confirmed by scripts/scb/discover.ts against the live
 * API and pinned in the fixture next to the tests. Lookups are tolerant of
 * case and diacritics so a renamed column in the new API still maps.
 */
export type ScbCompanyRow = Record<string, unknown>

function pick(row: ScbCompanyRow, ...names: string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const wanted = new Set(names.map(norm))
  for (const [k, v] of Object.entries(row)) {
    if (wanted.has(norm(k))) {
      if (v === null || v === undefined) return null
      const s = String(v).trim()
      return s === '' ? null : s
    }
  }
  return null
}

function coded(field: string, code: string | null, table: Record<string, string>, extra: Record<string, unknown> = {}): ScbFact | null {
  if (code === null) return null
  const c = code.replace(/^0+(?=\d)/, '') || '0'
  return { field, value: { code: c, label: table[c] ?? `Kod ${c}`, ...extra } }
}

function isoDate(s: string | null): string | null {
  if (!s) return null
  const d = s.replace(/[^0-9]/g, '')
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  return null
}

/** Map one Je row to facts. Unknown or empty variables simply produce nothing. */
export function factsFromScbCompany(row: ScbCompanyRow): ScbFact[] {
  const out: ScbFact[] = []
  const push = (f: ScbFact | null) => {
    if (f) out.push(f)
  }

  const name = pick(row, 'Företagsnamn', 'Foretagsnamn', 'Namn')
  if (name) push({ field: 'legal_name', value: name })
  const firma = pick(row, 'Firma')
  if (firma && firma !== name) push({ field: 'trade_name', value: firma })

  push(coded('f_tax', pick(row, 'F-skattstatus', 'Fskattstatus', 'FSkattStatus'), F_SKATT))
  push(coded('vat_registration', pick(row, 'Momsstatus'), MOMS))
  push(coded('employer_registration', pick(row, 'Arbetsgivarstatus'), ARBETSGIVARE))
  push(coded('company_status', pick(row, 'Företagsstatus', 'Foretagsstatus'), FORETAGSSTATUS))
  push(coded('legal_form', pick(row, 'Juridisk form', 'Juridiskform', 'JuridiskForm'), JURIDISK_FORM))
  const bv = pick(row, 'Status hos Bolagsverket', 'Bolagsverketstatus', 'StatusBolagsverket')
  push(coded('bolagsverket_status', bv, BOLAGSVERKET_STATUS, bv ? { warning: BOLAGSVERKET_WARNING_CODES.has(bv.replace(/^0+(?=\d)/, '') || '0') } : {}))
  push(coded('employees_band', pick(row, 'Storleksklass Anställda', 'StorleksklassAnstallda', 'Storleksklass anställda', 'AnstSME'), STORLEKSKLASS))

  const sni = pick(row, 'Bransch', 'Bransch_1', 'SNI', 'Näringsgren', 'Naringsgren')
  const sniText = pick(row, 'Bransch_1, text', 'Branschtext', 'Bransch text', 'Näringsgren, text', 'Naringsgrentext')
  if (sni) push({ field: 'industry', value: { code: sni, label: sniText ?? null } })

  const street = pick(row, 'Postadress', 'PostAdress')
  const postal = pick(row, 'PostNr', 'Postnr', 'Postnummer')
  const city = pick(row, 'PostOrt', 'Postort')
  const co = pick(row, 'COadress', 'COAdress', 'C/O-adress')
  if (street || postal || city) push({ field: 'postal_address', value: { street, co, postal_code: postal, city } })

  const municipality = pick(row, 'Säteskommun', 'Sateskommun', 'Säte kommun', 'Kommun')
  const county = pick(row, 'Säteslän', 'Sateslan', 'Säte län', 'Län')
  if (municipality || county) push({ field: 'seat', value: { municipality_code: municipality, county_code: county } })

  const registered = isoDate(pick(row, 'Registreringsdatum'))
  if (registered) push({ field: 'registered_at', value: registered })
  const started = isoDate(pick(row, 'Startdatum'))
  if (started) push({ field: 'active_since', value: started })
  const ended = isoDate(pick(row, 'Slutdatum'))
  if (ended) push({ field: 'active_until', value: ended })

  const phone = pick(row, 'Telefon')
  if (phone) push({ field: 'phone', value: phone })
  const email = pick(row, 'E-post', 'Epost', 'E-postadress')
  if (email) push({ field: 'email', value: email })
  const workplaces = pick(row, 'Antal arbetsställen', 'AntalArbetsstallen', 'Antal arbetsstallen')
  if (workplaces && /^\d+$/.test(workplaces)) push({ field: 'workplaces', value: Number(workplaces) })

  return out
}
