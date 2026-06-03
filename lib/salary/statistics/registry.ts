export interface SalaryStatReport {
  id: string
  name: string
  authority: string
  description: string
  period: 'month' | 'quarter' | 'year'
  implemented: boolean
}

/**
 * Salary statistics / authority reports gnubok can generate from salary runs.
 */
export const SALARY_STAT_REPORTS: SalaryStatReport[] = [
  {
    id: 'sus',
    name: 'Sjukfrånvaro under sjuklöneperioden (SuS)',
    authority: 'SCB',
    description: 'Månatlig fil över sjukfall under sjuklöneperioden (dag 1–14).',
    period: 'month',
    implemented: true,
  },
  {
    id: 'klp',
    name: 'Konjunkturlönestatistik (KLP)',
    authority: 'SCB',
    description: 'Månatlig konjunkturlönestatistik för privat sektor, aggregerad per personalkategori.',
    period: 'month',
    implemented: true,
  },
  {
    id: 'slp',
    name: 'Lönestrukturstatistik (SLP)',
    authority: 'SCB',
    description: 'Årlig strukturlönestatistik per individ (SSYK, CFAR, lön, arbetad tid).',
    period: 'year',
    implemented: true,
  },
  {
    id: 'sn',
    name: 'Lönestatistik',
    authority: 'Svenskt Näringsliv',
    description: 'Årlig individbaserad lönestatistik (samma postbeskrivning som SLP).',
    period: 'year',
    implemented: true,
  },
]
