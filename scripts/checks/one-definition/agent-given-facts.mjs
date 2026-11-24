export default {
  rule: 'agent-given-facts',
  says: 'The facts an agent is given are the memory rows that are not hidden and that no later fact has replaced.',
  home: 'src/lib/agent-context/remembered-facts.ts: filterGivenFacts, filterNotReplacedFacts',
  why: 'The briefing and the count on the agent picture left out a replaced fact while the memory list beside that count asked only whether a row was hidden, so a replaced fact that was shown again was listed as current and counted nowhere.',
  match: [/\.is\('superseded_by', null\)/],
  sanctioned: ['lib/agent-context/remembered-facts.ts'],
  allowed: {
    'lib/agent-context/agent-picture.ts': 'the count on the company card writes the two filters itself.',
  },
  // agent_memory is read from these; superseded_by on a bank connection is another rule.
  scan: ['app/api/agent', 'components/settings', 'extensions/general/mcp-server', 'lib/agent', 'lib/questions'],
}
