export default {
  rule: 'default-team-for-new-company',
  says: "A company created without a cookie session and without a named team attaches to its owner's personal team (kind personal, earliest created, then lowest id, the team ensure_user_team picks), to none when the owner has no personal team, and a failed read refuses the creation.",
  home: 'src/lib/company/default-team.ts: defaultTeamForNewCompany',
  why: 'POST /api/v1/companies and the MCP server each had a copy of the lookup, both ordered by teams(id) without selecting it, so PostgREST refused every lookup (42703); one door ignored the error, the other logged a warning, and every company they created without a team_id got no team.',
  match: [
    // .eq('teams.kind', 'personal'), an aliased embed, .filter(col, 'eq', 'personal')
    /['"`](?:\w+\.)?kind['"`]\s*,\s*(?:['"`]eq['"`]\s*,\s*)?['"`]personal['"`]/,
    // .match({ 'teams.kind': 'personal' })
    /['"`](?:\w+\.)?kind['"`]\s*:\s*['"`]personal['"`]/,
  ],
  sanctioned: ['lib/company/default-team.ts'],
}
