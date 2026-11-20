export default {
  rule: 'auto-lock-floor',
  says: 'Where the automatic lock puts the lock date is the newest calendar month end that lies at least auto_lock_period_days days back.',
  home: 'src/lib/company/auto-lock.ts: autoLockFloor, autoLockTarget',
  why: 'The setting was stored for seven months with nothing acting on it, while the settings page, the API and the systemdokumentation each described a different rule for it.',
  match: [
    // addDaysIso(today, -(settings.auto_lock_period_days ?? 0)): the days counted by hand.
    /\baddDays(?:Iso)?\(.*auto_?[lL]ock_?[pP]eriod_?[dD]ays/,
    // today - auto_lock_period_days, or the days turned into milliseconds.
    /[-+*]\s*[\w.?!]*auto_?[lL]ock_?[pP]eriod_?[dD]ays\b/,
    /\bauto_?[lL]ock_?[pP]eriod_?[dD]ays\b\s*[-+*]/,
    // daysBetweenIso(end, today) >= auto_lock_period_days: the days passed, compared by hand.
    /[a-zA-Z_)\]]\s*>=?\s*[\w.?!]*auto_?[lL]ock_?[pP]eriod_?[dD]ays\b/,
  ],
  sanctioned: ['lib/company/auto-lock.ts'],
}
