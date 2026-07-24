---
name: payroll
description: Run monthly Swedish payroll and prepare AGI. Use when the user says "lon", "loner", "lonekorning", "payroll", "arbetsgivardeklaration", "AGI", "arbetsgivaravgifter", or asks about salary bookings, formaner, or sick pay in a payroll context.
argument-hint: [month]
---

# Payroll

Run the monthly salary cycle: verify the salary run, stage the bookings, prepare the arbetsgivardeklaration (AGI). The product computes; the loaded skills explain; this flow never calculates tax from memory.

## Flow

1. If not already done this session, call `accounted_get_agent_briefing`. If the company has no employees, say so and stop (an enskild firma owner takes eget uttag, not salary; offer to explain via the loaded skill).
2. Load the knowledge: `accounted_load_skill("payroll-monthly")` (the monthly procedure) and `accounted_load_skill("horizontal/swedish-payroll")` for rules (skatteavdrag, arbetsgivaravgifter and age reductions, formaner, karensavdrag, semesterloneskuld).
3. Verify the month's salary run in the product: does it exist, is it complete, are one-off items in (bonus, sick days, formaner, utlagg)? Ask the user about anything the data cannot show.
4. Stage the salary bookings from the run and present the preview: gross, skatteavdrag, arbetsgivaravgifter, net, per the 7xxx account mapping the product produces. The user approves via `accounted_approve_pending_operation`.
5. Prepare the AGI underlag and state the filing deadline (from the product's deadline data, not memory). Filing with Skatteverket is the user's action unless the integration is connected.
6. Report in the user's language: booked, AGI status, deadline, anything pending.

## Rules

- Never compute tax deductions, avgifter, or forman values yourself; use the product's computed run and the loaded skills to sanity-check it.
- Every write stages a pending operation; the user approves before anything is booked.
- Payroll data is sensitive: show individual salaries only when the user asks for that level of detail.
