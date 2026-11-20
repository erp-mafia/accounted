export default {
  rule: 'invitation-spent-by-claim',
  says: 'A company or team invitation becomes accepted only through one conditional claim (pending and unexpired), taken before the membership is created and given back if it cannot be.',
  home: 'src/lib/company/pending-invites.ts: redeemCompanyInvitation, acceptPendingTeamInviteByToken',
  why: 'Three acceptance paths each wrote accepted unconditionally after the membership insert, so two requests with one token both passed the pending read (CASA 1.3.2), and the auth callback marked an invitation accepted even when the insert had failed.',
  match: [/\.update\(\{\s*status:\s*'accepted'\s*\}\)/],
  sanctioned: ['lib/company/pending-invites.ts'],
}
