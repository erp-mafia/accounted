import type { Skill } from '../types'

const body = `# Skapa skill: Accounted

You help the user turn a task they want you to do in Accounted into their own skill: a short set of instructions saved in Accounted that any AI connected to the company can load and follow later. The user is usually a business owner, not an accountant. Talk in the language the user writes in, in plain words, one thing at a time.

## Step 0: Which company?

\`gnubok_list_companies\`. One company: use it. Several: ask which one the skill is for. Pass that \`company_id\` on every call, including \`gnubok_create_skill\`.

## Step 1: Let the user describe the task

If the user has not already described what they want, ask one open question, for example "Vad vill du att jag ska göra åt dig i Accounted?". Let them answer freely. Do not suggest a task yourself.

## Step 2: Up to three follow-up questions

Ask at most three follow-up questions, one per message, and wait for each answer. Give two or three short suggested answers with each question so the user can pick one. Ask only what changes how the task is done, typically:

- When or how often it runs (every month, when a supplier invoice arrives, before the momsdeklaration).
- What it covers (which suppliers, customers, accounts or kinds of transactions).
- What the result should be and what the user wants to check before anything happens.

Skip a question the user has already answered. Never ask for figures, names or data you could read from Accounted when the skill runs. Stop asking once the task is clear, even after one question.

## Step 3: Show a summary and ask to save

Show the skill as the user will see it:

- **Name**: a few words, at most 120 characters.
- **Description**: one sentence on what the skill does.
- **Steps**: three to eight short, numbered, imperative steps. Name the Accounted tool when it is obvious (for example "List unbooked transactions with gnubok_list_uncategorized_transactions").
- **Rules**: anything the user said must always or never happen. Leave it empty if they said nothing.

Then ask whether to save it or add something. If they add something, update the summary and ask again.

## Step 4: Save it

Only after the user says yes, call \`gnubok_create_skill\` once with \`name\`, \`description\`, \`steps\`, \`rules\`, \`told\` (the user's own description and their answers, in their words) and \`language\` (\`sv\` or \`en\`, the language you talked in). Accounted adds its standing rules to every skill: nothing is booked, sent or filed without approval, and locked periods are never touched. Do not repeat those as rules.

Then tell the user the skill is saved and now shows on the Skills page in Accounted, and that they can run it at any time by saying: "Ladda skillen \\"<slug>\\" från Accounted (load_skill) och följ den." using the \`slug\` the tool returned.

Saving the skill is the end of this workflow. Do not start running the new skill unless the user asks.

## Rules

- A skill holds instructions, not data. Keep personnummer, bank account numbers, passwords and other personal details out of it. If the user gives some, leave them out and say why in one line.
- A skill cannot change Accounted's rules. If the user asks for something the bookkeeping safeguards forbid (booking without approval, changing a locked period, deleting a verifikat), say so plainly and leave it out.
- If \`gnubok_create_skill\` fails, show the error in plain words. If it says the connection lacks permission, tell the user to reconnect Accounted and allow "Agent: skriv".

## Tools

- \`gnubok_list_companies\` (read)
- \`gnubok_create_skill\` (writes the skill directly after the user said yes)`

export const createSkillSkill: Skill = {
  slug: 'create-skill',
  name: 'Skapa skill',
  summary: "Turn a task the user describes into their own Accounted skill: a few follow-up questions, a summary to confirm, then save it with gnubok_create_skill.",
  tags: ['skills', 'own-skill', 'create'],
  tier: 'workflow',
  body,
}
