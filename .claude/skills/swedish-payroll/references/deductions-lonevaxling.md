# Nettolöneavdrag vs Bruttolöneavdrag and Löneväxling

## Bruttolöneavdrag

Reduces gross salary before tax. Effects:
- Lowers taxable income
- Lowers arbetsgivaravgifter
- Lowers preliminary tax
- Lowers PGI (future pension)
- Lowers SGI (sickness benefit base)
- Does NOT reduce any förmånsvärde

Primary use case: löneväxling till pension. Can only apply to future earnings (never retroactive).

## Nettolöneavdrag

Deducts from net salary after tax has been calculated. Effects:
- Does NOT affect taxable income, arbetsgivaravgifter, PGI, or SGI
- DOES reduce the taxable förmånsvärde if the deduction constitutes payment for a specific benefit

Common uses: bilförmån co-payment, parking, lunch subsidies, benefit platform selections.

## Processing order (critical)

1. Apply bruttolöneavdrag
2. Calculate förmånsvärden (reduced by nettolöneavdrag if applicable)
3. Determine tax base
4. Look up tax via skattetabell
5. Compute net pay
6. Apply nettolöneavdrag
7. Arrive at utbetalat belopp

Arbetsgivaravgifter are calculated on gross after bruttolöneavdrag but before any nettolöneavdrag.

## Löneväxling till pension

Employee reduces gross salary; employer pays equivalent plus bonus into tjänstepension. The bonus derives from the tax differential: arbetsgivaravgifter at 31.42% on salary vs SLP at 24.26% on pension contributions.

### The 1.058 factor

For every 1 SEK salary reduction, standard pension contribution = 1.058 SEK (5.8% bonus = employer's saving passed to employee).

```
pension_contribution = löneväxling_amount × 1.058
new_gross = original_gross - löneväxling_amount
employer_cost_on_salary = new_gross × 0.3142
SLP_on_pension = pension_contribution × 0.2426
```

### Thresholds to flag

If post-löneväxling salary drops below 8.07 × IBB / 12 (2026: ~56,087 SEK/month), the employee loses pension accrual in allmänna pensionssystemet. Löneväxling also reduces SGI. Software should flag when post-reduction salary approaches this floor.

### Employer pension deductibility cap

35% of pensionsmedförande lön or 10 × PBB/year (2026: 592,000 SEK), whichever is lower.