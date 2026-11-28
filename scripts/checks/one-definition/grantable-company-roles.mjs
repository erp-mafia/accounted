export default {
  rule: 'grantable-company-roles',
  says: 'The company roles an invitation or a role change under Användare may grant are admin, member, viewer and invoicer, never owner.',
  home: 'src/lib/company/member-roles.ts: GRANTABLE_COMPANY_ROLES',
  why: 'The invite route listed the grantable roles inline; with role changes on members and invitations, three doors and the role pickers would each carry a copy that could drift apart.',
  match: [/\[\s*'(?:admin|member|viewer|invoicer)',\s*'(?:admin|member|viewer|invoicer)',\s*'(?:admin|member|viewer|invoicer)',\s*'(?:admin|member|viewer|invoicer)'\s*\]/],
  sanctioned: ['lib/company/member-roles.ts'],
}
