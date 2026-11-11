/**
 * The AGI redovisningsperiod of a salary run: the payout month. Defined in
 * the deadlines block (lib/deadlines/agi-reporting-period.ts) so the AGI
 * period check payments runs too can read it; payroll and its client
 * components keep reading it from here.
 */
export {
  agiPeriodDiffersFromRunPeriod,
  agiReportingPeriod,
  formatAgiPeriodCompact,
  formatAgiPeriodDashed,
} from '@/lib/deadlines/agi-reporting-period'
export type { AgiReportingPeriod } from '@/lib/deadlines/agi-reporting-period'
