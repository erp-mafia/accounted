# Aktiv vs Passiv Näringsverksamhet

<!-- toc -->
**Contents**

- [Legal basis](#legal-basis)
- [Why the classification matters](#why-the-classification-matters)
- [Definitions and tests](#definitions-and-tests)
- [Important rättsfall](#important-rättsfall)
- [Tips for implementing software](#tips-for-implementing-software)
- [NE-bilaga / INK1 representation](#ne-bilaga--ink1-representation)
- [Common pitfalls](#common-pitfalls)
- [Worked example: which is cheaper?](#worked-example-which-is-cheaper)

<!-- /toc -->

## Legal basis

- IL 2 kap 23 §: defines aktiv vs passiv näringsverksamhet
- IL 67 kap 5-9 §§: aktiv NV gives basis for jobbskatteavdrag (skattereduktion)
- IL 59 kap: pensionssparavdrag requires aktiv
- Socialavgiftslagen (SAL) 2000:980: egenavgifter on aktiv
- Lagen (1990:659) om särskild löneskatt: SLP on passiv

## Why the classification matters

This is the most consequential single classification decision for an EF. It cascades into:

| Mechanism | Aktiv | Passiv |
|---|---|---|
| Socialavgift on överskott | Egenavgifter 28,97% (with karens 7) | Särskild löneskatt 24,26% |
| Generell nedsättning 7,5% (max 15 000 kr) | YES on 40 001-200 000 kr | NO |
| Sjukpenninggrundande inkomst (SGI) | YES | NO |
| Pensionsgrundande inkomst (PGI) | YES | NO |
| Föräldrapenninggrundande inkomst | YES | NO |
| Jobbskatteavdrag (skattereduktion) | YES (worth up to ~30 000 kr/year) | NO |
| Pensionssparavdrag (35% / 10 PBB) | YES | NO |
| Kvittning av underskott mot tjänst (nystartad) | YES (first 5 years, capped 100k/år) | NO |
| Allmänna avdrag rätt | Limited | None |

The asymmetry: **SLP (24,26%) is lower than egenavgifter (28,97%)** at first glance, but the active näringsidkare gets nedsättning 7,5% and jobbskatteavdrag and lower marginal tax via grundavdrag and pension contribution savings. The active classification is almost always more favorable except for pure capital-yield businesses.

## Definitions and tests

### Aktivitetsregeln (the activity rule)

You are aktiv if you devote at least **one-third of full-time work** to verksamheten. Skatteverket interprets *full-time* as 1500 hours/year → **threshold ≈ 500 hours/year**.

Quote: *"Du anses ha en aktiv näringsverksamhet om du ägnar sysslorna i verksamheten minst en tredjedel av den tid som går åt till en vanlig anställning på heltid."*

### Aktivitetsregeln: alternative (low-hour personal services)

If verksamheten:
- Is based on your own labor (not on a tillgång)
- Requires only a limited number of hours

then it counts as aktiv even below 500 h. Example: a konsult who runs the konsultrörelse parallel to an employment, where the labor is the core asset, is aktiv regardless of hour count.

This rule does NOT apply if the inkomst is essentially capital yield from a tillgång (rental property, lantbruk where the soil produces the income).

### Huvudsaklighetsregeln (the primary activity rule)

If you run multiple verksamheter (e.g., one konsult + one hyresfastighet), they are aggregated into a single näringsverksamhet (en näringskälla). The aktiv/passiv classification is then made on the *aggregated* verksamhet.

Tested in 4 steps:
1. Aggregate all delverksamheter into one.
2. Compute total arbetsinsats.
3. If under 1/3 (500 h), look at balansomslutningen: is the capital component dominant? If yes → passiv.
4. If balansomslutningen is *not* significant, judge whether the verksamhet is primarily own labor or capital → aktiv if labor-based.

### Smittoeffekt (does aktiv "infect" passiv?)

Earlier doctrine: yes: if one delverksamhet is aktiv, the aggregated whole becomes aktiv. Modern interpretation: not automatic; samlad bedömning required. But where labor exceeds 500 h in one part, the aggregated whole usually becomes aktiv.

Exempel: hyresfastighet (~150 h/år, isolerat passiv) + ny konsultverksamhet (~400 h/år) i samma EF → kombinerat 550 h, överstiger tredjedelsregeln → hela den sammanslagna EF:n klassas som **aktiv**, även om hyresintäkten dominerar balansomslutningen.

## Important rättsfall

- **RÅ 2002 ref 15**: skogsägare counted as aktiv despite very low hours, because owner performed all required work himself
- **Kammarrätten i Göteborg, mål 1157-09**: lantbrukare 300-400 h not enough; she had hired in services for heavy mechanical work, so own labor was not the primary input → passiv
- **Kammarrätten i Göteborg, mål 4392-09**: näringsidkare with hyresfastighet + pelletsanläggning claimed 700 h; domstolen disbelieved the hour count, denied aktiv status
- **Kammarrätten i Stockholm 3503-11**: if the *only* income is återföring of P-fond from a previously aktiv year, the year counts as **passiv** (no longer earning aktiv income). Likewise an only income consisting of avstämning av föregående års egenavgifter is passiv.

## Tips for implementing software

If you build software that classifies aktiv/passiv:
- Persist a **timesheet** (`arbetsinsats` per dag eller månad) per verksamhetsår
- Surface a warning when hours < 500 AND balansomslutning > a threshold (suggesting passiv risk)
- For *konsultverksamhet* with low hours, flag the aktivitetsregeln-alternativ (labor-based small consultancy)
- Track aggregate hours across all delverksamheter in the same EF
- Sjukpenning income classified as aktiv NV income if originally based on aktiv verksamhet (Skatteverket dnr 131 141234-06/111)

## NE-bilaga / INK1 representation

The aktiv/passiv classification appears on **INK1 sid 2**:
- Ruta **10.1**: överskott aktiv
- Ruta **10.2**: underskott aktiv
- Ruta **10.3**: överskott passiv
- Ruta **10.4**: underskott passiv

And on **NE sid 1** there's a kryssruta for passiv (default is aktiv).

The schablonavdrag on NE sid 2:
- R43 = **25%** for aktiv (egenavgifter), **20%** for SLP, **10%** for pensionärer

## Common pitfalls

1. **Claiming aktiv without supporting hour log**: Skatteverket may demand a written timesheet under en revision; without one, default is often passiv if hours are below 500
2. **Forgetting smittoeffekt across delverksamheter**: adding a small konsultrörelse to an existing passiv hyresfastighet can flip the aggregate to aktiv (or vice versa)
3. **Treating sjukpenning as aktiv when verksamheten was passiv**: sjukpenning inherits the underlying classification, not flipped to aktiv automatically
4. **Spousal aktiv/passiv mismatch**: for makar driving gemensam verksamhet, the bedömning is normally the *same* for both (IL 60 kap), so if one is aktiv, both are
5. **Pensionär trap**: for personer födda 1937 or earlier, there is no egenavgift either way (0%), so aktiv vs passiv only matters for SLP if passiv (24,26% pure tax, no förmåner)

## Worked example: which is cheaper?

For a non-pensionär näringsidkare with 100 000 kr överskott:
- **Aktiv**: 28,97 % egenavgift = 28 970 kr; nedsättning = 7,5 % × 100 000 = 7 500 kr (nedsättningen tas av hela underlaget när överskott > 40 000 kr; ingen subtraktion av 40 000), netto egenavgift ≈ 21 470 kr; PLUS jobbskatteavdrag och grundavdrag reducerar inkomstskatten ytterligare.
- **Passiv**: 24,26 % SLP = 24 260 kr; ingen nedsättning, inget jobbskatteavdrag.

Net: aktiv is roughly 15 000-17 000 kr cheaper per year at this income level. Above brytpunkten the gap narrows because nedsättning caps at 200k underlag and JSA tapers off, but aktiv usually still wins unless the verksamhet is purely capital-yield.

See also [[egenavgifter-sgi-pgi-jsa]] for nedsättningar and [[kvittning-underskott]] for the 5-year kvittningsregel that only aktiv (nystartad) gives access to.
