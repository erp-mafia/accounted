/**
 * Label for a hole in a voucher series, as detect_voucher_gaps reports it:
 * "A7" when one number is missing, "A1 till A5" for a run. The joiner is the
 * caller's translated "till"/"to" so the label follows the UI language.
 */
export function formatVoucherGapRange(
  gap: { series: string; gap_start: number; gap_end: number },
  joiner: string,
): string {
  const from = `${gap.series}${gap.gap_start}`
  if (gap.gap_end <= gap.gap_start) return from
  return `${from} ${joiner} ${gap.series}${gap.gap_end}`
}
