/**
 * Swedish field labels for employee-import validation messages. Kept in a
 * file with no server imports so the review step (a client component) can
 * tell which messages belong to the fields it lets the user edit.
 */
export const EMPLOYEE_FIELD_LABELS: Record<string, string> = {
  first_name: 'Förnamn',
  last_name: 'Efternamn',
  personnummer: 'Personnummer',
  employment_start: 'Anställningsdatum',
  employment_degree: 'Sysselsättningsgrad',
  hours_per_week: 'Timmar per vecka',
  salary_type: 'Löneform',
  monthly_salary: 'Månadslön',
  hourly_rate: 'Timlön',
  tax_table_number: 'Skattetabell',
  tax_column: 'Skattekolumn',
  tax_municipality: 'Kommun',
  clearing_number: 'Clearingnummer',
  bank_account_number: 'Kontonummer',
  vacation_days_per_year: 'Semesterdagar',
  email: 'E-post',
  phone: 'Telefon',
  cutover_date: 'Brytdatum',
  ytd_gross: 'Ingående bruttolön',
  ytd_tax: 'Ingående skatt',
  ytd_net: 'Ingående nettolön',
  vacation_paid_days_remaining: 'Kvarvarande semesterdagar',
}

/** Header row of the downloadable CSV template (matches the detector). */
export const EMPLOYEE_TEMPLATE_HEADERS = [
  'Förnamn', 'Efternamn', 'Personnummer', 'Anställningsdatum', 'Sysselsättningsgrad',
  'Månadslön', 'Timlön', 'Skattetabell', 'Kolumn', 'Kommun', 'Clearingnummer', 'Kontonummer',
  'E-post', 'Telefon', 'Semesterdagar', 'Timmar per vecka',
  'Ingående bruttolön', 'Ingående skatt', 'Ingående nettolön', 'Kvarvarande semesterdagar', 'Brytdatum',
]
