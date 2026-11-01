/**
 * The simulated company as facts: who it sells to, what it buys, who it pays
 * and when, for 33 months from its first day. Pure: the same seed and scale give
 * the same company, and nothing here knows how the product books anything.
 *
 * Amounts are whole kronor before moms, so moms at 25, 12 and 6 % stays exact to
 * the öre and every rounding in the books is the product's own.
 */

export type SimScaleName = 'small' | 'full'

interface SimScale {
  swedishCustomers: number
  salesPerMonth: number
  hoursPerSale: readonly [min: number, max: number]
  cardCostsPerMonth: number
  extraEmployees: number
}

export const SCALES: Record<SimScaleName, SimScale> = {
  small: { swedishCustomers: 8, salesPerMonth: 6, hoursPerSale: [4, 80], cardCostsPerMonth: 2, extraEmployees: 0 },
  full: { swedishCustomers: 60, salesPerMonth: 70, hoursPerSale: [2, 16], cardCostsPerMonth: 25, extraEmployees: 5 },
}

export const SIM_COMPANY = {
  name: 'Simulerat Konsult AB',
  orgNumber: '556677-8899',
  bankgiro: '991-2346',
  address: { line1: 'Simuleringsgatan 1', postalCode: '11122', city: 'Stockholm' },
  contact: { name: 'Sara Simulant', email: 'ekonomi@simulerat-konsult.example', phone: '08-1234567' },
  shareCapital: 50_000,
  firstDay: '2024-01-02',
  lastDay: '2026-09-30',
  closedYears: [2024, 2025],
  openYear: 2026,
} as const

export type VatRate = 25 | 12 | 6 | 0

export interface SimCustomer {
  key: string
  name: string
  type: 'swedish_business' | 'eu_business' | 'non_eu_business'
  country: string
  orgNumber?: string
  vatNumber?: string
}

export interface SimSupplier {
  key: string
  name: string
  type: 'swedish_business' | 'eu_business'
  country: string
  orgNumber?: string
  vatNumber?: string
}

export interface SimEmployee {
  key: string
  firstName: string
  lastName: string
  personnummer: string
  owner: boolean
  start: string
  /** Column 1 of this Skatteverket table. */
  taxTable: 30 | 33
  /** Gross per month, by year, from the month the person started. */
  salary: Record<number, number>
}

export interface SaleLine {
  description: string
  quantity: number
  unit: string
  unitPrice: number
  vatRate: VatRate
}

export interface PurchaseLine {
  description: string
  account: string
  net: number
  vatRate: VatRate
}

interface Dated {
  date: string
}

export type SimEvent = Dated &
  (
    | { type: 'share_capital'; amount: number }
    | { type: 'open_fiscal_year'; year: number }
    | { type: 'sale'; id: string; customer: string; dueDate: string; lines: SaleLine[] }
    | { type: 'sale_payment'; saleId: string; viaBankRow: boolean }
    | { type: 'credit_note'; saleId: string }
    | { type: 'purchase'; id: string; supplier: string; number: string; dueDate: string; lines: PurchaseLine[] }
    | { type: 'purchase_payment'; purchaseId: string }
    | { type: 'asset'; id: string; purchaseId: string; name: string; cost: number; usefulLifeMonths: number }
    | { type: 'card_cost'; category: string; account?: string; net: number; vatRate: VatRate; text: string }
    | { type: 'bank_fee'; amount: number }
    | { type: 'salary_change'; employee: string; monthlySalary: number }
    | { type: 'payroll'; year: number; month: number }
    | { type: 'payroll_taxes_paid'; year: number; month: number }
    | { type: 'vat_settlement'; year: number; quarter: number }
    | { type: 'vat_paid'; year: number; quarter: number }
    | { type: 'stock_count'; year: number; value: number }
    | { type: 'depreciation'; year: number }
    | { type: 'corporate_tax'; year: number }
    | { type: 'year_end'; year: number }
    | { type: 'annual_report'; year: number }
    | { type: 'corporate_tax_paid'; year: number }
  )

export interface SimPlan {
  seed: number
  scale: SimScaleName
  customers: SimCustomer[]
  suppliers: SimSupplier[]
  employees: SimEmployee[]
  events: SimEvent[]
}

/** mulberry32: small, seedable, and the same on every machine. */
function createRandom(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    /** An integer from min to max, both included. */
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    chance: (probability: number) => next() < probability,
    pick: <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)],
  }
}

type Random = ReturnType<typeof createRandom>

const iso = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The day itself, or the Monday after a weekend: nothing here is paid on a Sunday. */
function weekday(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay()
  return day === 6 ? addDays(date, 2) : day === 0 ? addDays(date, 1) : date
}

/** Fabricated: the +60 day marks a samordningsnummer, and none here belongs to anyone. */
function samordningsnummer(year: number, month: number, day: number, serial: number): string {
  const body = `${String(year).slice(2)}${String(month).padStart(2, '0')}${String(day + 60)}${String(serial).padStart(3, '0')}`
  const sum = [...body].reduce((total, digit, index) => {
    const doubled = Number(digit) * (index % 2 === 0 ? 2 : 1)
    return total + (doubled > 9 ? doubled - 9 : doubled)
  }, 0)
  return `${year}${body.slice(2)}${(10 - (sum % 10)) % 10}`
}

const PREFIXES = ['Nordljus', 'Fjällgård', 'Östersund', 'Granhed', 'Solvik', 'Björkdal', 'Havsbris', 'Ljungvik', 'Stenbro', 'Älvsby']
const TRADES = ['Bygg', 'Data', 'Logistik', 'Media', 'Fastigheter', 'Energi', 'Hälsa', 'Handel']

function buildCustomers(count: number): SimCustomer[] {
  const swedish: SimCustomer[] = Array.from({ length: count }, (_, index) => ({
    key: `customer-${index + 1}`,
    name: `${PREFIXES[index % PREFIXES.length]} ${TRADES[index % TRADES.length]} ${Math.floor(index / 40) + 1} AB`,
    type: 'swedish_business',
    country: 'SE',
  }))
  return [
    ...swedish,
    { key: 'eu-de', name: 'Simuliert Beratung GmbH', type: 'eu_business', country: 'DE', vatNumber: 'DE999999999' },
    { key: 'eu-fi', name: 'Simuloitu Palvelu Oy', type: 'eu_business', country: 'FI', vatNumber: 'FI99999999' },
    { key: 'export-no', name: 'Simulert Radgivning AS', type: 'non_eu_business', country: 'NO' },
  ]
}

const SUPPLIERS: SimSupplier[] = [
  { key: 'landlord', name: 'Simulerade Lokaler AB', type: 'swedish_business', country: 'SE' },
  { key: 'telecom', name: 'Simulerad Telekom AB', type: 'swedish_business', country: 'SE' },
  { key: 'software', name: 'Simulerad Programvara AB', type: 'swedish_business', country: 'SE' },
  { key: 'accountant', name: 'Simulerad Redovisning AB', type: 'swedish_business', country: 'SE' },
  { key: 'insurance', name: 'Simulerad Försäkring AB', type: 'swedish_business', country: 'SE' },
  { key: 'hotel', name: 'Simulerat Hotell AB', type: 'swedish_business', country: 'SE' },
  { key: 'rail', name: 'Simulerade Tåg AB', type: 'swedish_business', country: 'SE' },
  { key: 'hardware', name: 'Simulerad Hårdvara AB', type: 'swedish_business', country: 'SE' },
  { key: 'cloud-ie', name: 'Simulated Cloud Ltd', type: 'eu_business', country: 'IE', vatNumber: 'IE9999999WA' },
]

function buildEmployees(extra: number): SimEmployee[] {
  const people: SimEmployee[] = [
    {
      key: 'owner',
      firstName: 'Sara',
      lastName: 'Simulant',
      personnummer: samordningsnummer(1980, 3, 14, 11),
      owner: true,
      start: '2024-01-01',
      taxTable: 30,
      salary: { 2024: 42_000, 2025: 45_000, 2026: 48_000 },
    },
    {
      key: 'consultant-1',
      firstName: 'Erik',
      lastName: 'Exempel',
      personnummer: samordningsnummer(1988, 7, 2, 23),
      owner: false,
      start: '2024-02-01',
      taxTable: 30,
      salary: { 2024: 38_000, 2025: 39_500, 2026: 41_000 },
    },
    {
      key: 'consultant-2',
      firstName: 'Lina',
      lastName: 'Lindtest',
      personnummer: samordningsnummer(1992, 11, 21, 34),
      owner: false,
      start: '2024-09-01',
      taxTable: 33,
      salary: { 2024: 36_000, 2025: 37_000, 2026: 38_500 },
    },
  ]
  for (let index = 0; index < extra; index += 1) {
    people.push({
      key: `consultant-${index + 3}`,
      firstName: `Anställd${index + 3}`,
      lastName: 'Simulant',
      personnummer: samordningsnummer(1985 + index, 1 + index, 5 + index, 45 + index),
      owner: false,
      start: iso(2025, 1 + index, 1),
      taxTable: index % 2 === 0 ? 30 : 33,
      salary: { 2025: 35_000 + index * 1_000, 2026: 36_000 + index * 1_000 },
    })
  }
  return people
}

interface SaleOutcome {
  sale: Extract<SimEvent, { type: 'sale' }>
  payment: SimEvent | null
  credit: SimEvent | null
}

function buildSale(random: Random, index: number, date: string, customer: SimCustomer, hours: number): SaleOutcome {
  const id = `sale-${index}`
  const rate = random.pick([950, 1050, 1150, 1250, 1375]) + random.int(0, 95)
  const domestic = customer.type === 'swedish_business'
  const lines: SaleLine[] = [
    { description: 'Konsulttimmar', quantity: hours, unit: 'tim', unitPrice: rate, vatRate: domestic ? 25 : 0 },
  ]
  if (domestic && random.chance(0.15)) {
    lines.push({ description: 'Kurslitteratur, e-bok', quantity: random.int(1, 12), unit: 'st', unitPrice: 249, vatRate: 6 })
  }
  if (domestic && random.chance(0.1)) {
    lines.push({ description: 'Lunch vid kursdag', quantity: random.int(4, 16), unit: 'st', unitPrice: 135, vatRate: 12 })
  }
  const sale = { type: 'sale' as const, date, id, customer: customer.key, dueDate: addDays(date, 30), lines }

  // One sale in 25 is credited in full; the rest are paid, a little late or early.
  if (random.chance(0.04)) {
    return { sale, payment: null, credit: { type: 'credit_note', date: weekday(addDays(date, random.int(3, 20))), saleId: id } }
  }
  const paid = weekday(addDays(date, random.int(18, 44)))
  return {
    sale,
    payment: { type: 'sale_payment', date: paid, saleId: id, viaBankRow: index % 4 === 0 },
    credit: null,
  }
}

function monthlyPurchases(random: Random, year: number, month: number, index: { next: number }): SimEvent[] {
  const events: SimEvent[] = []
  const add = (supplier: string, day: number, lines: PurchaseLine[], paidAfterDays = 25) => {
    const id = `purchase-${(index.next += 1)}`
    const date = iso(year, month, day)
    events.push({
      type: 'purchase',
      date,
      id,
      supplier,
      number: `${supplier.slice(0, 3).toUpperCase()}-${index.next}`,
      dueDate: addDays(date, 30),
      lines,
    })
    events.push({ type: 'purchase_payment', date: weekday(addDays(date, paidAfterDays)), purchaseId: id })
  }

  add('landlord', 1, [{ description: 'Lokalhyra', account: '5010', net: 14_000 + (year - 2024) * 600, vatRate: 25 }], 3)
  add('telecom', 4, [{ description: 'Telefoni och bredband', account: '6212', net: random.int(1_400, 1_900), vatRate: 25 }])
  add('software', 6, [{ description: 'Affärssystem och licenser', account: '6540', net: random.int(2_200, 3_400), vatRate: 25 }])
  add('cloud-ie', 9, [{ description: 'Molntjänster', account: '6540', net: random.int(1_500, 4_200), vatRate: 0 }])
  add('hotel', 14, [{ description: 'Hotell vid kundbesök', account: '5831', net: random.int(900, 4_200), vatRate: 12 }])
  add('rail', 15, [{ description: 'Tågresor', account: '5810', net: random.int(500, 2_400), vatRate: 6 }])
  if (month % 3 === 0) {
    add('accountant', 20, [{ description: 'Redovisningstjänster', account: '6530', net: random.int(5_500, 8_500), vatRate: 25 }])
  }
  if (month === 1) {
    add('insurance', 10, [{ description: 'Företagsförsäkring', account: '6310', net: 9_600 + (year - 2024) * 400, vatRate: 0 }])
  }
  return events
}

/** The handelsvaror the signed list counts on each balansdag: a stock count books the change, as year_end. */
const STOCK_VALUE: Record<number, number> = { 2024: 40_000, 2025: 25_000 }

const CARD_COSTS = [
  { category: 'expense_office', account: '6110', vatRate: 25, text: 'Kontorsmaterial', min: 180, max: 1_900 },
  { category: 'expense_software', account: '6540', vatRate: 25, text: 'Mjukvaruprenumeration', min: 90, max: 900 },
  { category: 'expense_marketing', account: '5910', vatRate: 25, text: 'Annonsering', min: 400, max: 4_800 },
] as const

/** Assets bought over the years: the supplier invoice books them, the register depreciates them. */
const ASSET_PURCHASES = [
  { date: '2024-02-12', name: 'Bärbara datorer', cost: 60_000, usefulLifeMonths: 60 },
  { date: '2024-09-16', name: 'Kontorsmöbler', cost: 48_000, usefulLifeMonths: 60 },
  { date: '2025-05-12', name: 'Skärmar och dockor', cost: 36_000, usefulLifeMonths: 60 },
  { date: '2026-03-16', name: 'Bärbara datorer, utbyte', cost: 45_000, usefulLifeMonths: 60 },
]

export function generateCompany(seed: number, scaleName: SimScaleName): SimPlan {
  const random = createRandom(seed)
  const scale = SCALES[scaleName]
  const customers = buildCustomers(scale.swedishCustomers)
  const employees = buildEmployees(scale.extraEmployees)
  const swedishCustomers = customers.filter((customer) => customer.type === 'swedish_business')
  const foreignCustomers = customers.filter((customer) => customer.type !== 'swedish_business')
  const events: SimEvent[] = [{ type: 'share_capital', date: SIM_COMPANY.firstDay, amount: SIM_COMPANY.shareCapital }]
  const purchases = { next: 0 }
  let saleIndex = 0

  const addPurchaseOf = (date: string, name: string, cost: number, usefulLifeMonths: number) => {
    const id = `purchase-${(purchases.next += 1)}`
    events.push({
      type: 'purchase',
      date,
      id,
      supplier: 'hardware',
      number: `HAR-${purchases.next}`,
      dueDate: addDays(date, 30),
      lines: [{ description: name, account: '1220', net: cost, vatRate: 25 }],
    })
    events.push({ type: 'purchase_payment', date: weekday(addDays(date, 21)), purchaseId: id })
    events.push({ type: 'asset', date, id: `asset-${id}`, purchaseId: id, name, cost, usefulLifeMonths })
  }
  for (const asset of ASSET_PURCHASES) addPurchaseOf(asset.date, asset.name, asset.cost, asset.usefulLifeMonths)

  for (let year = 2024; year <= 2026; year += 1) {
    if (year > 2024) {
      events.push({ type: 'open_fiscal_year', date: iso(year - 1, 12, 15), year })
      for (const employee of employees) {
        const monthlySalary = employee.salary[year]
        if (monthlySalary === undefined || employee.start.startsWith(`${year}-`)) continue
        events.push({ type: 'salary_change', date: iso(year, 1, 2), employee: employee.key, monthlySalary })
      }
    }
    const lastMonth = year === 2026 ? 9 : 12
    for (let month = 1; month <= lastMonth; month += 1) {
      // July is quiet, as it is for every Swedish consultancy.
      const sales = month === 7 ? Math.ceil(scale.salesPerMonth / 3) : scale.salesPerMonth
      for (let count = 0; count < sales; count += 1) {
        saleIndex += 1
        const foreign = random.chance(0.08)
        const customer = foreign ? random.pick(foreignCustomers) : random.pick(swedishCustomers)
        const day = random.int(1, lastDayOfMonth(year, month))
        const saleDate = weekday(iso(year, month, Math.min(day, 26)))
        const hours = random.int(scale.hoursPerSale[0], scale.hoursPerSale[1])
        const { sale, payment, credit } = buildSale(random, saleIndex, saleDate, customer, hours)
        events.push(sale)
        if (payment) events.push(payment)
        if (credit) events.push(credit)
      }
      events.push(...monthlyPurchases(random, year, month, purchases))

      for (let count = 0; count < scale.cardCostsPerMonth; count += 1) {
        const cost = random.pick(CARD_COSTS)
        events.push({
          type: 'card_cost',
          date: weekday(iso(year, month, random.int(2, 27))),
          category: cost.category,
          account: cost.account,
          net: random.int(cost.min, cost.max),
          vatRate: cost.vatRate,
          text: cost.text,
        })
      }
      if (month % 3 === 2) {
        // Meal representation: no income tax deduction, moms on the part within 300 kr per person.
        events.push({
          type: 'card_cost',
          date: weekday(iso(year, month, 18)),
          category: 'expense_representation',
          net: 1_000,
          vatRate: 12,
          text: 'Kundlunch, fyra personer, kundmöte om ramavtal',
        })
      }
      events.push({ type: 'bank_fee', date: weekday(iso(year, month, lastDayOfMonth(year, month))), amount: 245 })

      const payday = weekday(iso(year, month, 25))
      events.push({ type: 'payroll', date: payday, year, month })
      const following = month === 12 ? iso(year + 1, 1, 12) : iso(year, month + 1, 12)
      // AGI and payment fall on the 12th, the 17th in January and August.
      const taxDay = month === 12 || month === 7 ? `${following.slice(0, 8)}17` : following
      if (taxDay <= SIM_COMPANY.lastDay) {
        events.push({ type: 'payroll_taxes_paid', date: weekday(taxDay), year, month })
      }

      if (month % 3 === 0) {
        const quarter = month / 3
        events.push({ type: 'vat_settlement', date: iso(year, month, lastDayOfMonth(year, month)), year, quarter })
        const dueMonth = month + 2
        const due = dueMonth > 12 ? iso(year + 1, dueMonth - 12, 12) : iso(year, dueMonth, dueMonth === 8 ? 17 : 12)
        if (due <= SIM_COMPANY.lastDay) events.push({ type: 'vat_paid', date: weekday(due), year, quarter })
      }
    }
    if (year !== 2026) {
      events.push({ type: 'stock_count', date: iso(year, 12, 31), year, value: STOCK_VALUE[year] })
      events.push({ type: 'depreciation', date: iso(year, 12, 31), year })
      events.push({ type: 'corporate_tax', date: iso(year, 12, 31), year })
      events.push({ type: 'year_end', date: iso(year + 1, 3, 20), year })
      events.push({ type: 'annual_report', date: iso(year + 1, 5, 20), year })
      // Slutlig skatt falls due in the November after the tax return.
      const taxPaid = iso(year + 1, 11, 12)
      if (taxPaid <= SIM_COMPANY.lastDay) events.push({ type: 'corporate_tax_paid', date: weekday(taxPaid), year })
    }
  }

  // What falls after the last day stays open: a company never ends with nothing unpaid.
  const ordered = events
    .filter((event) => event.date <= SIM_COMPANY.lastDay)
    .map((event, position) => ({ event, position }))
    .sort((a, b) => a.event.date.localeCompare(b.event.date) || a.position - b.position)
    .map(({ event }) => event)
  return { seed, scale: scaleName, customers, suppliers: SUPPLIERS, employees, events: ordered }
}
