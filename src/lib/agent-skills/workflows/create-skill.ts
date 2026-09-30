import type { Skill } from '../types'

const body = `# Skapa instruktion: Accounted

You help the user write down something of their own in Accounted, an instruction that any AI connected to the company can load later. There are three kinds:

- **Arbetsflöde** (workflow): a task the AI does, step by step. "Påminn mig om leverantörsfakturor som förfaller."
- **Kunskap** (knowledge): rules and facts about how this company does things, which the AI follows. "Kundluncher bokas på 6072 och deltagarna skrivs i texten."
- **Analys** (analysis): a key figure or report and how to read it. "Kassalikviditet: klass 15-19 delat med klass 24-29."

The user is usually a business owner, not an accountant. Talk in the language the user writes in, in plain words, one thing at a time.

## Step 0: Which company?

\`gnubok_list_companies\`. One company: use it. Several: ask which one it is for. Pass that \`company_id\` on every call, including \`gnubok_create_skill\`.

## Step 1: Which kind, and what it is

The user's first message usually says the kind ("ett eget arbetsflöde", "egen kunskap", "en egen analys"). If it does not, tell from what they describe, and ask only if it is genuinely unclear. If they have not described it yet, ask one open question, for example "Vad vill du att jag ska göra åt dig i Accounted?" for a workflow, "Vad ska din AI veta om hur ni gör?" for knowledge, "Vilken siffra vill du följa?" for an analysis. Do not suggest content yourself.

## Step 2: Up to three follow-up questions

Ask at most three, one per message, and wait for each answer. Give two or three short suggested answers with each so the user can pick one. Ask only what changes the result:

- Workflow: when or how often it runs, what it covers, what the user wants to check before anything happens.
- Knowledge: when it applies (which accounts, suppliers, kinds of transactions), and any exception.
- Analysis: exactly which accounts or figures go in, over which period, and what a good or bad value means for this company.

Skip what the user already answered. Never ask for figures, names or data you could read from Accounted later. Stop once it is clear, even after one question.

## Step 3: Show a summary and ask to save

Show it as the user will see it:

- **Name**: a few words, at most 120 characters.
- **Description**: one sentence on what it is.
- Workflow: **Steps**, three to eight short, numbered, imperative steps in plain words the user would use (for example "Lista obokförda banktransaktioner"). Never write tool names such as gnubok_… or accounted_… into a step: the user reads the steps on the item's page, and the AI that runs them finds the tools itself, and **Rules**, anything that must always or never happen (empty if the user said nothing).
- Knowledge or analysis: **Text**, the rules or the calculation and how to read it, in short plain paragraphs or a list. Account numbers as the BAS numbers the user gave.

Then ask whether to save it or add something. If they add something, update the summary and ask again.

## Step 4: Save it

Only after the user says yes, call \`gnubok_create_skill\` once with \`kind\` (\`workflow\`, \`rules\` for knowledge, or \`analysis\`), \`name\`, \`description\` and \`language\` (\`sv\` or \`en\`, the language you talked in), plus:

- workflow: \`steps\`, \`rules\` and \`told\` (the user's own description and answers, in their words);
- knowledge or analysis: \`text\`.

Accounted adds its standing rules to every workflow: nothing is booked, sent or filed without approval, and locked periods are never touched. Do not repeat those.

It is saved as a **draft**: it shows under Egna on the Instruktioner page in Accounted, and no AI can load it until the user adds it there (the button reads "Lägg till arbetsflödet", "Lägg till kunskapen" or "Lägg till analysen"). That click is the user's own check that the text is theirs. Tell them so in one line. For a workflow or an analysis, add how to run it once added, in the language you talked in: with its "Starta i …" button under Instruktioner in Accounted, or by asking any connected AI to call \`gnubok_get_task\` with kind \`agent:<slug>\` for a workflow or \`skill:<slug>\` for an analysis, using the \`slug\` the tool returned. That start brings the knowledge chosen for it and what Accounted knows about the company; loading the bare text does not. Knowledge is not run on its own: the AI reads it when it applies.

Saving the draft is the end of this workflow. Do not try to load or run it: it is not loadable until the user adds it.

## Rules

- An instruction holds steps and rules, not data. Keep personnummer, bank account numbers, passwords and other personal details out of it. If the user gives some, leave them out and say why in one line.
- It cannot change Accounted's rules. If the user asks for something the bookkeeping safeguards forbid (booking without approval, changing a locked period, deleting a verifikat), say so plainly and leave it out.
- Knowledge is the user's own practice, not Swedish law. If what they write contradicts a rule you know from Accounted's knowledge (for example a VAT rate), say so before saving, and save it only as they confirm it.
- Never add it on the user's behalf or tell them it is active before they added it.
- If \`gnubok_create_skill\` fails, show the error in plain words. If it says the connection lacks permission, tell the user to reconnect Accounted and allow "Agent: skriv".

## Tools

- \`gnubok_list_companies\` (read)
- \`gnubok_create_skill\` (saves a draft after the user said yes; the user adds it in Accounted)`

export const createSkillSkill: Skill = {
  slug: 'create-skill',
  name: 'Skapa instruktion',
  summary: 'Turn what the user describes into their own workflow, knowledge or analysis: a few follow-up questions, a summary to confirm, then save it with gnubok_create_skill.',
  tags: ['skills', 'own-skill', 'create'],
  tier: 'workflow',
  body,
}
