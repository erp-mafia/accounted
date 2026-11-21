/**
 * The avsättningsår a periodiseringsfond account names, from the BAS
 * convention: 2120-2128 are the fonder of 2020-2028, 2129 the fond of 2019
 * (BAS 2020), and 2130-2139 their "nr 2" twins (2130 "Periodiseringsfond
 * 2020: nr 2"). Null for an account that names no year, e.g. 2110
 * periodiseringsfonder in general. Read by the bokslut's fond register and
 * by the INK2 uppräkning (4.6d).
 */
export function cohortYearFromAccount(accountNumber: string): number | null {
  if (!/^21[23]\d$/.test(accountNumber)) return null
  const lastDigit = parseInt(accountNumber.slice(-1), 10)
  // BAS 2020: 2129 represents 2019 by convention; 2128 = 2028.
  if (lastDigit === 9) return 2019
  // For 0-8, the cohort year is in the 2020s. As fiscal years extend past
  // 2029 the convention will recycle (2120 might mean 2030 then); cap at
  // 2020-decade interpretation for now and surface ambiguity in a warning.
  return 2020 + lastDigit
}
