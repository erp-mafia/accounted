export default {
  rule: 'recurring-run-record',
  says: 'A run that creates a recurring invoice claims the schedule, records the invoice on it before the send and settles a run that did not finish in one place, whichever door started it.',
  home: 'src/lib/invoices/recurring-schedule-run.ts: runRecurringSchedule',
  why: '"Skapa faktura nu" recorded its run after the send with no claim gate and only logged a failed record, so the hourly run billed the same period again (accounted#213).',
  match: [/executeRecurringSchedule\(/, /claimRecurringScheduleRun\(/],
  sanctioned: [
    'lib/invoices/recurring-schedule-run.ts',
    'lib/invoices/recurring-schedule-service.ts',
    'lib/invoices/recurring-schedule-claim.ts',
  ],
}
