export default {
  rule: 'register-row-reader',
  says: 'Which salary run reads an absence or worked-days row is the run it is carried to (carried_to_run_id, a late day) or else the run whose deviation window holds its date; readers ask registerRowReadByRun and lateDayReaderRunIds, and writes ask the register lock.',
  home: 'src/lib/salary/late-days.ts: registerRowReadByRun',
  why: 'Every reader filtered the registers by date alone, so a day known after its run was paid had no run to read it, and a day carried to a later run would still have been read by a correction of the paid run, deducted twice and declared in the wrong period.',
  match: [
    // A read of a register table: it must apply the reading rule (or be a
    // listing that shows the rows, not a run that reads them).
    /\.from\(['"]salary_absence_days['"]\)/,
    /\.from\(['"]salary_worked_days['"]\)/,
  ],
  sanctioned: [
    'lib/salary/late-days.ts',
    'lib/salary/register-locks.ts',
    'lib/salary/absence.ts',
    'lib/salary/worked-days.ts',
    'lib/salary/derive-absence-line-items.ts',
    'lib/salary/run-calculation.ts',
    'lib/salary/agi/generate-declaration.ts',
  ],
  allowed: {
    'lib/salary/run-employees.ts':
      'Counts the calendar rows in the window to refuse a per-run hours total; late hours are paid on top of either, so a carry changes nothing there.',
    'app/api/salary/employees/[id]/worked-hours/batch/route.ts':
      'Writes each day itself after the register lock decided its carry, and reads the stored notes and shift windows of the days it overwrites.',
  },
}
