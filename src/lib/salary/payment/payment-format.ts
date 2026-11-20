/**
 * The salary payment file formats and the URLs of their bank list.
 *
 * Kept free of server imports so client components can narrow a format that
 * arrives as DOM text (a select value) to the known union before it reaches
 * a URL, and build that URL with encoded parameters only.
 */

export const SALARY_PAYMENT_FILE_FORMATS = ['pain001', 'bg_lb'] as const
export type SalaryPaymentFileFormat = (typeof SALARY_PAYMENT_FILE_FORMATS)[number]

/** The format when `value` is one of the known formats, otherwise null. */
export function parseSalaryPaymentFormat(value: unknown): SalaryPaymentFileFormat | null {
  return (SALARY_PAYMENT_FILE_FORMATS as readonly unknown[]).includes(value)
    ? (value as SalaryPaymentFileFormat)
    : null
}

/**
 * URL of the bank list (JSON) or its PDF for a run and format. The run id is
 * path-encoded and the format, re-checked against the allow-list, goes into
 * the query through URLSearchParams.
 */
export function salaryBankListUrl(
  salaryRunId: string,
  format: SalaryPaymentFileFormat,
  kind: 'json' | 'pdf' = 'json',
): string {
  const checked = parseSalaryPaymentFormat(format)
  if (!checked) throw new Error('Unknown salary payment file format')
  const path = `/api/salary/runs/${encodeURIComponent(salaryRunId)}/payment/bank-list${kind === 'pdf' ? '/pdf' : ''}`
  return `${path}?${new URLSearchParams({ format: checked }).toString()}`
}
