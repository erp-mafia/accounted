---
name: openapi-to-skill
description: >-
  Turn an OpenAPI/Swagger spec (JSON or YAML, file or URL) into an installable
  agent skill for consuming that API. Use when the user invokes
  /openapi-to-skill, points at an openapi.json or swagger.yaml, or asks to
  "build a skill for this API" or "make these API docs agent-ready".
metadata:
  internal: true
---

This is a local pointer so the skill is invocable inside this repo. The
canonical skill (kept installable for external consumers via
`npx skills add erp-mafia/accounted --skill openapi-to-skill`) lives at:

**`skills/openapi-to-skill/SKILL.md`** (repo root)

Read that file and follow it. Its bundled tool is at
`skills/openapi-to-skill/scripts/openapi-inventory.mjs` and the output
template at `skills/openapi-to-skill/references/output-template.md`.
