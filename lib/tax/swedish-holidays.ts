/**
 * Swedish holidays including Easter calculation
 * Used for adjusting tax deadlines that fall on weekends or holidays
 */

/**
 * Calculate Easter Sunday using the Anonymous Gregorian algorithm
 * (Meeus/Jones/Butcher algorithm)
 */
export function calculateEasterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1 // 0-indexed
  const day = ((h + l - 7 * m + 114) % 31) + 1

  return new Date(year, month, day)
}

/**
 * Get all Swedish public holidays for a given year
 * Returns dates in YYYY-MM-DD format
 */
export function getSwedishHolidays(year: number): string[] {
  const holidays: Date[] = []

  // Fixed holidays
  holidays.push(new Date(year, 0, 1))   // Nyårsdagen
  holidays.push(new Date(year, 0, 6))   // Trettondedag jul
  holidays.push(new Date(year, 4, 1))   // Första maj
  holidays.push(new Date(year, 5, 6))   // Sveriges nationaldag
  holidays.push(new Date(year, 11, 24)) // Julafton
  holidays.push(new Date(year, 11, 25)) // Juldagen
  holidays.push(new Date(year, 11, 26)) // Annandag jul
  holidays.push(new Date(year, 11, 31)) // Nyårsafton

  // Easter-based holidays
  const easter = calculateEasterSunday(year)

  // Långfredagen (Good Friday) - 2 days before Easter
  const goodFriday = new Date(easter)
  goodFriday.setDate(easter.getDate() - 2)
  holidays.push(goodFriday)

  // Påskafton (Easter Saturday) - 1 day before Easter
  const easterSaturday = new Date(easter)
  easterSaturday.setDate(easter.getDate() - 1)
  holidays.push(easterSaturday)

  // Påskdagen (Easter Sunday)
  holidays.push(easter)

  // Annandag påsk (Easter Monday) - 1 day after Easter
  const easterMonday = new Date(easter)
  easterMonday.setDate(easter.getDate() + 1)
  holidays.push(easterMonday)

  // Kristi himmelsfärdsdag (Ascension Day) - 39 days after Easter
  const ascensionDay = new Date(easter)
  ascensionDay.setDate(easter.getDate() + 39)
  holidays.push(ascensionDay)

  // Pingstdagen (Pentecost/Whitsunday) - 49 days after Easter
  const pentecost = new Date(easter)
  pentecost.setDate(easter.getDate() + 49)
  holidays.push(pentecost)

  // Midsommarafton - Friday between June 19-25
  const midsommarAfton = getMidsommarAfton(year)
  holidays.push(midsommarAfton)

  // Midsommardagen - Saturday between June 20-26
  const midsommardagen = new Date(midsommarAfton)
  midsommardagen.setDate(midsommarAfton.getDate() + 1)
  holidays.push(midsommardagen)

  // Alla helgons dag - Saturday between Oct 31 - Nov 6
  const allaHelgonsDag = getAllaHelgonsDag(year)
  holidays.push(allaHelgonsDag)

  // Convert to YYYY-MM-DD format
  return holidays.map((date) => formatDateISO(date))
}

/**
 * Get Midsommarafton (Friday between June 19-25)
 */
function getMidsommarAfton(year: number): Date {
  // Find the Friday between June 19-25
  for (let day = 19; day <= 25; day++) {
    const date = new Date(year, 5, day) // June
    if (date.getDay() === 5) {
      // Friday
      return date
    }
  }
  throw new Error('Could not calculate Midsommarafton')
}

/**
 * Get Alla helgons dag (Saturday between Oct 31 - Nov 6)
 */
function getAllaHelgonsDag(year: number): Date {
  // Find the Saturday between Oct 31 - Nov 6
  for (let offset = 0; offset <= 6; offset++) {
    const date = new Date(year, 9, 31 + offset) // Oct 31 + offset
    if (date.getDay() === 6) {
      // Saturday
      return date
    }
  }
  throw new Error('Could not calculate Alla helgons dag')
}

/**
 * Format date to YYYY-MM-DD
 */
function formatDateISO(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Check if a date is a Swedish holiday
 */
export function isSwedishHoliday(date: Date): boolean {
  const holidays = getSwedishHolidays(date.getFullYear())
  return holidays.includes(formatDateISO(date))
}

/**
 * Check if an ISO date string (YYYY-MM-DD) is a Swedish public holiday.
 * Parses by string only — no Date / timezone math — so callers using UTC
 * boundaries (e.g. the shift-premium engine) get a stable answer.
 */
export function isSwedishHolidayISO(isoDate: string): boolean {
  const year = parseInt(isoDate.slice(0, 4), 10)
  if (Number.isNaN(year)) return false
  const holidays = getSwedishHolidays(year)
  return holidays.includes(isoDate)
}

/**
 * Check if a date is a weekend (Saturday or Sunday)
 */
export function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 6 // Sunday = 0, Saturday = 6
}

/**
 * Check if a date is a banking day (not weekend, not holiday)
 */
export function isBankingDay(date: Date): boolean {
  return !isWeekend(date) && !isSwedishHoliday(date)
}

/**
 * Get the next banking day from a given date
 * If the date is already a banking day, return it
 * Otherwise, find the next banking day
 */
export function getNextBankingDay(date: Date): Date {
  const result = new Date(date)

  while (!isBankingDay(result)) {
    result.setDate(result.getDate() + 1)
  }

  return result
}

/**
 * Get the previous banking day from a given date
 * If the date is already a banking day, return it
 * Otherwise, find the previous banking day
 */
export function getPreviousBankingDay(date: Date): Date {
  const result = new Date(date)

  while (!isBankingDay(result)) {
    result.setDate(result.getDate() - 1)
  }

  return result
}

/**
 * Adjust a deadline date to the next banking day if it falls on a weekend or holiday
 * Skatteverket deadlines that fall on non-banking days are moved to the next banking day
 */
export function adjustDeadlineToNextBankingDay(date: Date): Date {
  return getNextBankingDay(date)
}

/**
 * Get the month name in Swedish
 */
export function getSwedishMonthName(month: number): string {
  const months = [
    'januari',
    'februari',
    'mars',
    'april',
    'maj',
    'juni',
    'juli',
    'augusti',
    'september',
    'oktober',
    'november',
    'december',
  ]
  return months[month]
}

/**
 * Get quarter number (1-4) from month (0-11)
 */
export function getQuarterFromMonth(month: number): number {
  return Math.floor(month / 3) + 1
}

/**
 * Get the first month of a quarter (0-indexed)
 */
export function getFirstMonthOfQuarter(quarter: number): number {
  return (quarter - 1) * 3
}

/**
 * Get the last month of a quarter (0-indexed)
 */
export function getLastMonthOfQuarter(quarter: number): number {
  return quarter * 3 - 1
}
