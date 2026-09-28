---
description: Pin this folder to one Accounted company. Writes .accounted.json in the working directory so every Accounted flow started here targets that company.
argument-hint: [company name or organisationsnummer]
---

Pin the current working directory to one Accounted company. Argument: `$ARGUMENTS`.

## Steps

1. Call `accounted_list_companies`.
2. Match the argument against `name` and `org_number`: case-insensitive substring, ignoring spaces and hyphens in the organisationsnummer. No argument: list the companies (name, organisationsnummer, role, default marker) and ask which one. Several matches: list them and ask. No match: say so and list what exists; never guess.
3. Write `.accounted.json` in the current working directory with exactly this shape, values taken from the list:

   ```json
   { "company_id": "<company_id>", "name": "<name>" }
   ```

   If the file already exists, say which company it pointed at and replace it.
4. If the folder is a git repository and `.accounted.json` is not already ignored, ask whether to add it to `.gitignore` (it is a local pointer, not project source). Add it only if the user agrees.
5. Confirm in one line: company name, organisationsnummer, the path written, and that every Accounted flow started from this folder now targets that company. `/accounted:use` again re-pins; deleting the file unpins.

## Rules

- The company comes from the list, never from memory or from the argument text alone.
- This command writes one local file and nothing in Accounted.
