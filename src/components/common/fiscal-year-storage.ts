/**
 * Persisted fiscal-year scope: the localStorage key prefix (companyId is
 * appended) and the sentinel for an explicit "all years" choice. Lives in
 * its own dependency-free module so lib/ code (the reference-data scope
 * resolver) can import it without pulling a React component along.
 * FiscalYearSelector re-exports both for existing importers.
 */
export const STORAGE_KEY_PREFIX = 'Accounted:fiscal-year:'
export const ALL_YEARS_VALUE = '__all__'
