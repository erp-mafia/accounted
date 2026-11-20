export default {
  rule: 'scheduled-hours-per-day',
  says: 'An absence or worked day without stated hours is one scheduled day of that employee, hours_per_week / workdays_per_week.',
  home: 'src/lib/salary/work-schedule.ts: defaultDayHours',
  why: 'The doors defaulted to 8 h while the calendar and the engine read the schedule: one unpaid day at 40 h over 4 days took 1 846,51 kr off the pay instead of 2 308,14 kr.',
  match: [/\bhours\w*\s*\?\?\s*8\b/i, /hours\w*:\s*z\.number\(\)[^\n]*\.default\(8\)/i],
  scan: ['lib/salary/', 'lib/api/', 'lib/pending-operations/', 'app/api/', 'extensions/general/mcp-server/'],
}
