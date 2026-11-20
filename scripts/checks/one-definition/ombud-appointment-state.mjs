export default {
  rule: 'ombud-appointment-state',
  says: "A company's appointment of the app as ombud reads as not appointed, waiting on Skatteverket, appointed or withdrawn, and a behörighet as withdrawn only when it counted on this opt-in and no longer does.",
  home: 'src/lib/skatteverket/ombud-appointment.ts: ombudAppointment',
  why: 'The settings card read a grant Skatteverket had not registered yet as red Saknas, the same as a withdrawn one, while Hem, Kom igång and the toasts each worked the state out on their own.',
  match: [
    /last_probe_detail\??\.(lasombud|moms_ombud)\??\.reason/,
    /(lasombud|moms_ombud)_status\s*[!=]==\s*['"](granted|denied|unknown|error)['"]/,
  ],
  sanctioned: [
    'lib/skatteverket/ombud-appointment.ts',
    'extensions/general/skatteverket/lib/connection-store.ts',
  ],
  allowed: {
    'app/api/extensions/skatteverket/ombud/sync/cron/route.ts':
      'isAnyGranted counts the rows that hold a grant now for the downgrade guard: the sync deciding what to write, not a surface showing a state.',
  },
}
