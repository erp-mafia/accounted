# Industry (vertical) atoms

Each subdirectory here is one vertical atom: industry-specific knowledge the
specialized accountant agent loads when the composer picks it for a company.

```
.claude/skills/industry/
├── README.md                   ← this file
├── konsult-it/
│   ├── SKILL.md
│   └── references/             ← optional deeper material
│       └── ...
├── restaurang-cafe/
│   └── SKILL.md
└── e-handel/
    └── SKILL.md
```

## Authoring contract

Each `SKILL.md` must start with YAML frontmatter:

```yaml
---
id: vertical/<slug>                  # MUST match the directory name
tier: vertical                       # always 'vertical' under industry/
title: "Display name"
description: >
  One paragraph the composer reads when deciding whether to load this atom.
  Cover the activity, the SNI codes it maps to, and the 3-5 most distinctive
  patterns (typical BAS accounts, regulatory edge cases, counterparty types).
sni_prefixes: ["62.01", "62.02", "62.09"]
trigger_signals:
  counterparty_patterns: ["Stripe.*", "AWS.*", "GitHub.*"]
  bas_account_patterns: ["1230", "6230"]
estimated_tokens: 8000               # optional; seeder auto-computes from body
version: 1
---
```

Body sections (suggested, not enforced):

1. **When to use**: short paragraph; helps the agent decide when to lean on
   this knowledge mid-conversation.
2. **Typical patterns**: workflow cadence (invoicing, expenses, reconciliation).
3. **BAS account patterns**: the accounts this industry uses heavily.
4. **Regulatory edge cases**: quirks specific to the industry (e.g. ROT/RUT
   for bygg, alkohollagen for restaurang, EU OSS for e-handel).
5. **Counterparties to recognize**: common suppliers, payment processors,
   trade associations.
6. **References**: links into deeper `references/*.md` files in the same dir.

## Authoring tips

- Match the **style of the existing horizontal `swedish-*` skills**:
  developer-oriented, precise, sparse. Not user-facing prose.
- Quote BAS account numbers as strings (`"1465"`, not `1465`).
- Mention SNI codes explicitly when relevant (`SNI 56.10`).
- Avoid duplicating content from the horizontal skills: the composer loads
  both. If a topic belongs in `swedish-vat`, link to it (`[[horizontal/swedish-vat]]`)
  instead of inlining it.
- If a section is going to be > 200 lines, split it into a file under
  `references/` and link to it from `SKILL.md`.

## Adding a new atom

1. Create a new subdirectory under `.claude/skills/industry/<slug>/`.
2. Write `SKILL.md` with the frontmatter above.
3. Run `npx tsx scripts/seed-agent-atom-registry.ts` to upsert the atom row
   into `agent_atom_registry`.
4. The composer will start considering the atom on the next signup or
   "Bygg om" rebuild: no code changes required.

## Removing or deprecating

Set `is_active: false` in frontmatter and re-seed, or set the column directly
in the DB. Existing `agent_profiles.vertical_atoms` arrays may still reference
the inactive ID; the runtime loader skips inactive atoms.
