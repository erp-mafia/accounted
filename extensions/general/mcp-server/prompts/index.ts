import type { McpPrompt } from './types'

/**
 * Single-action prompts. Each one is a Swedish slash-shortcut that directs
 * the model to call exactly one Accounted tool and report a short answer.
 */
export const prompts: McpPrompt[] = [
  {
    name: 'whats_overdue',
    description: 'Visa förfallna kundfakturor',
    text:
      'Lista mina förfallna kundfakturor. Anropa gnubok_list_invoices med status="overdue" ' +
      'och svara på svenska med en kort lista: kundnamn, belopp, antal dagar förfallen. ' +
      'Inga rekommendationer: bara fakta.',
  },
  {
    name: 'cash_today',
    description: 'Visa banksaldo just nu',
    text:
      'Hur mycket pengar har jag på företagskontot just nu? Anropa gnubok_get_balance_sheet ' +
      'för dagens datum och rapportera saldot på konto 1930. Visa även de senaste 5 transaktionerna ' +
      'via gnubok_list_uncategorized_transactions (limit=5, sortera nyast först: men inkludera även ' +
      'kategoriserade om verktyget tillåter). Svara kort på svenska.',
  },
  {
    name: 'last_month_result',
    description: 'Resultat förra månaden',
    text:
      'Visa resultaträkningen för föregående kalendermånad. Anropa gnubok_get_income_statement ' +
      'med rätt datumintervall och svara på svenska med tre siffror: intäkter, kostnader, resultat. ' +
      'Ingen analys.',
  },
  {
    name: 'vat_due',
    description: 'Moms att betala / återfå',
    text:
      'Vad är min momsskuld eller momsfordran för innevarande momsperiod? Anropa gnubok_get_vat_report ' +
      'och rapportera enbart ruta 49 (att betala / att få tillbaka) samt deadline för deklarationen. ' +
      'Ingen analys.',
  },
  {
    name: 'uncategorized_count',
    description: 'Okontrerade transaktioner',
    text:
      'Hur många banktransaktioner är okontrerade? Anropa gnubok_list_uncategorized_transactions ' +
      'och svara på svenska med tre uppgifter: antal, datum för äldsta transaktion, totalbelopp. ' +
      'Inga åtgärdsförslag.',
  },
]

export function findPrompt(name: string): McpPrompt | null {
  return prompts.find((p) => p.name === name) ?? null
}

export type { McpPrompt }
