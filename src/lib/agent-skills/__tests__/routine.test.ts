import { describe, expect, it } from 'vitest'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import {
  COWORK_WEB, PERIOD_FLOWS, coworkLink, isPeriodFlow, parseRoutineQuery, parseRoutineSent,
  routinePrompt, routineQuery, routineSummary, routineTime, routineWhen, type RoutineTranslate,
} from '../routine'

function translator(locale: 'sv' | 'en'): RoutineTranslate {
  // A missing key throws instead of falling back to its path, so every string the request uses must exist.
  const t = createTranslator({ locale, messages: locale === 'sv' ? sv : en, namespace: 'skills_registry', onError: (error) => { throw error } })
  return t as unknown as RoutineTranslate
}

const company = { id: '0f6f4a36-8d3e-4c5b-9b7a-2f1e3d4c5b6a', name: 'Exempel AB' }
const run = 'Hitta kvittona som saknas.'
const weekly = { cadence: 'weekly' as const, day: 'mon' as const, time: '07:00' }

describe('routine timing', () => {
  it('names the zone and spells out a weekday in Swedish', () => {
    const t = translator('sv')
    expect(routineWhen({ cadence: 'daily', day: 'mon', time: '06:30' }, t)).toBe('varje dag kl 06:30 svensk tid')
    expect(routineWhen({ cadence: 'weekdays', day: 'mon', time: '07:00' }, t)).toBe('varje vardag (måndag till fredag) kl 07:00 svensk tid')
    expect(routineWhen({ cadence: 'weekly', day: 'fri', time: '16:30' }, t)).toBe('varje fredag kl 16:30 svensk tid')
  })

  it('does the same in English', () => {
    const t = translator('en')
    expect(routineWhen({ cadence: 'weekdays', day: 'mon', time: '07:00' }, t)).toBe('every weekday (Monday to Friday) at 07:00 Swedish time')
    expect(routineWhen({ cadence: 'weekly', day: 'sun', time: '21:00' }, t)).toBe('every Sunday at 21:00 Swedish time')
  })

  it('keeps a valid time and otherwise falls back to the last valid one', () => {
    expect(routineTime('18:30')).toBe('18:30')
    expect(routineTime('')).toBe('07:00')
    expect(routineTime('25:00')).toBe('07:00')
    // A cleared time input keeps what was there instead of turning into 07:00 unseen.
    expect(routineTime('', '16:45')).toBe('16:45')
  })
})

describe('routine request', () => {
  it('pins the whole Swedish request for a flow', () => {
    expect(routinePrompt({ choice: weekly, run, readOnly: false, company }, translator('sv'))).toBe(
      'Skapa en schemalagd uppgift som körs varje måndag kl 07:00 svensk tid (Europe/Stockholm). '
      + `Den gäller bolaget Exempel AB (company_id ${company.id}): skicka company_id "${company.id}" på varje anrop till Accounted. `
      + 'Varje gång den körs: Hitta kvittona som saknas. '
      + 'Ingen är med när den körs, så skicka "unattended": true när du anropar get_task och ställ inga frågor. '
      + 'Lägg förslag för godkännande i Accounted. Godkänn aldrig förslag själv, det gör jag i Accounted. '
      + 'Avsluta med en kort sammanfattning av vad som väntar på mig. '
      + 'Kör uppgiften en gång direkt nu medan jag är här, så att jag ser att den når Accounted och kan tillåta verktygen.',
    )
  })

  it('gives an analysis a read-only request that proposes nothing', () => {
    const prompt = routinePrompt({ choice: weekly, run: 'Kör "Kassaprognos 30 dagar".', readOnly: true, company }, translator('sv'))
    expect(prompt).toContain('ändra ingenting i Accounted och lägg inga förslag')
    expect(prompt).not.toContain('Lägg förslag för godkännande')
    expect(prompt).toContain('Kör "Kassaprognos 30 dagar".')
  })

  it.each([
    ['sv', false, ['Godkänn aldrig förslag själv', 'Kör uppgiften en gång direkt nu medan jag är här', 'Lägg förslag för godkännande']],
    ['sv', true, ['Godkänn aldrig förslag själv', 'Kör uppgiften en gång direkt nu medan jag är här', 'ändra ingenting']],
    ['en', false, ['Never approve proposals yourself', 'Run the task once right now while I am here', 'Stage proposals for approval']],
    ['en', true, ['Never approve proposals yourself', 'Run the task once right now while I am here', 'change nothing']],
  ] as const)('in %s (analysis: %s) runs unattended for the company, never approves and runs once now', (locale, readOnly, phrases) => {
    const prompt = routinePrompt({ choice: weekly, run, readOnly, company }, translator(locale))
    expect(prompt).toContain('"unattended": true')
    expect(prompt).toContain('get_task')
    expect(prompt).toContain(company.name)
    expect(prompt).toContain(`company_id "${company.id}"`)
    expect(prompt).toContain('Europe/Stockholm')
    for (const phrase of phrases) expect(prompt).toContain(phrase)
  })

  it('never sends more than Cowork takes', () => {
    expect(routinePrompt({ choice: weekly, run: 'x'.repeat(20000), readOnly: false, company }, translator('sv')).length).toBe(14000)
  })

  it('reads as one plain sentence on the page, without the machine text', () => {
    const sv = routineSummary({ choice: weekly, readOnly: false, company }, 'Månadsavslut', translator('sv'))
    expect(sv).toBe('Claude kör "Månadsavslut" för Exempel AB varje måndag kl 07:00 svensk tid och lägger förslag som du godkänner i Accounted. Första gången kör Claude den direkt, medan du är kvar.')
    const analysis = routineSummary({ choice: weekly, readOnly: true, company }, 'Kassaprognos', translator('en'))
    expect(analysis).toContain('Nothing changes in Accounted.')
    for (const text of [sv, analysis]) {
      expect(text).not.toContain('get_task')
      expect(text).not.toContain(company.id)
    }
  })
})

describe('period flows', () => {
  it('knows the month-end close and VAT flows', () => {
    expect(isPeriodFlow('month-end-close')).toBe(true)
    expect(isPeriodFlow('quarterly-vat-review')).toBe(true)
    expect(isPeriodFlow('bookkeep')).toBe(false)
  })

  it.each([['sv', sv, 'inget väntar'], ['en', en, 'nothing is waiting']] as const)('has a run text in %s that does the job only when the period is not done', (_, messages, nothing) => {
    const says = messages.skills_registry.routine_say as Record<string, string>
    for (const id of PERIOD_FLOWS) expect(says[id]).toContain(nothing)
  })
})

describe('routine links', () => {
  it('opens a new Cowork task in Claude Desktop with the request encoded', () => {
    expect(coworkLink('Kör "bookkeep" & svara kort')).toBe('claude://cowork/new?q=K%C3%B6r%20%22bookkeep%22%20%26%20svara%20kort')
  })

  it('opens Claude on the web with no text in the URL', () => {
    expect(COWORK_WEB).toBe('https://claude.ai/cowork/new')
  })
})

describe('routine hand-over from Skriv själv', () => {
  it('round-trips a chosen routine through the item page URL', () => {
    const q = routineQuery({ cadence: 'weekly', day: 'fri', time: '16:30' })
    expect(q).toBe('rutin=weekly&dag=fri&tid=16%3A30')
    expect(parseRoutineQuery(new URLSearchParams(q))).toEqual({ cadence: 'weekly', day: 'fri', time: '16:30' })
    expect(parseRoutineSent(new URLSearchParams(q))).toBeNull()
  })

  it('says where saving already sent it, so the panel opens with what to do next', () => {
    const q = routineQuery({ cadence: 'daily', day: 'mon', time: '06:00' }, 'desktop')
    expect(q).toBe('rutin=daily&dag=mon&tid=06%3A00&skickad=desktop')
    expect(parseRoutineSent(new URLSearchParams(q))).toBe('desktop')
    expect(parseRoutineSent(new URLSearchParams('rutin=weekly&skickad=web_uncopied'))).toBe('web_uncopied')
  })

  it('ignores an unknown sent flag, or one without a routine', () => {
    expect(parseRoutineSent(new URLSearchParams('rutin=weekly&skickad=elsewhere'))).toBeNull()
    expect(parseRoutineSent(new URLSearchParams('skickad=web'))).toBeNull()
  })

  it('ignores a missing or unknown routine and repairs day and time', () => {
    expect(parseRoutineQuery(new URLSearchParams(''))).toBeNull()
    expect(parseRoutineQuery(new URLSearchParams('rutin=biweekly'))).toBeNull()
    expect(parseRoutineQuery(new URLSearchParams('rutin=daily&dag=xyz&tid=99:99'))).toEqual({ cadence: 'daily', day: 'mon', time: '07:00' })
  })
})
