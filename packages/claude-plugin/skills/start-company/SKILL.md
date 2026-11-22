---
name: start-company
description: Start a new Swedish aktiebolag from the conversation, from the first question to a company set up in Accounted. Use when the user says "starta aktiebolag", "starta bolag", "bilda AB", "start a company in Sweden", or asks what to enter on verksamt.se, who must sit on the board, or what to do when the organisation number arrives.
---

# Start company

Interview the founder, make the founding documents, guide the bank, verksamt.se and Skatteverket steps, and set the company up in Accounted once Bolagsverket has registered it.

## Flow

1. Call `accounted_load_skill("start-company")` and follow it. It works before the user has an Accounted account: the interview needs none.
2. When the founder asks for the documents, call `accounted_formation` with `action: "save"`. That is the first call that needs an account: in Claude Code, `/mcp` signs in; in another client, its sign-in for the `accounted` MCP server. A user without an account creates it on that same screen (BankID or e-mail, about a minute).
3. After registration, `accounted_formation` with `action: "setup"` previews the company; it is created only after the founder has read the preview and confirmed.

## Rules

- Never ask for, repeat or store a personnummer in the chat. Each person types their own on the page `accounted_formation` names (`page_url`).
- Never sign, pay or submit on verksamt.se for the founder: that is their BankID.
- The documents come from Accounted, never written by you.
- Swedish company, tax or accounting questions are answered from loaded skills, never from memory.
- Flow names: `/accounted:<name>` is how Claude Code spells this plugin's flows. In another client, use the skill or command named `<name>`.
