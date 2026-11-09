export default {
  rule: 'ombud-org-number-claim',
  says: "A company may hold Accounted's ombud connection on an org number when it is the only live claimant, or, among several, the one claimant a current member proved with their own BankID.",
  home: 'src/extensions/general/skatteverket/lib/connection-store.ts: ombudClaimStanding',
  why: 'The deep link, Kontrollera nu and the hourly register sync each decide it, and a door that read the proof differently would let a tenant that typed a victim\'s org number inherit the victim\'s grant.',
  match: [/\.eq\(\s*['"]auth_mode['"]\s*,\s*['"]user['"]\s*\)/],
  sanctioned: ['extensions/general/skatteverket/lib/connection-store.ts'],
}
