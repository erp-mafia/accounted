# Product atoms

Product-tier atoms describe how Accounted itself works: features, screens, and
the choices users face inside them. They exist because the in-app assistant's
other tiers are all accounting-domain knowledge (horizontal = Swedish
regulatory, vertical = industry, modifier = company situation), and none of
them can answer "how does this feature work?" questions.

Like horizontal atoms, product atoms apply to every company and are always
active; the composer never selects or deselects them per company profile.

One directory per atom: `product/<slug>/SKILL.md`, discovered by
`scripts/lib/atom-discovery.ts` and seeded into `agent_atom_registry` via
`npm run skills:generate` (id: `product/<slug>`).

Authoring rules:

- Describe what the feature DOES today, sourced from the code, not from memory.
  When the feature changes, the atom must change in the same PR.
- Write the body in Swedish: this is what the assistant quotes to end users.
- Keep the description frontmatter keyword-rich (it is the trigger surface for
  progressive disclosure), and the body compact: one feature per atom.
