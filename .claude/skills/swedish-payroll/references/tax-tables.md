# Skatteavdrag (Tax Tables)

## Tax table lookup system

Employers withhold preliminary tax using skattetabeller published annually by Skatteverket. Each table is numbered 29-42, corresponding to the employee's total municipal tax rate (kommunalskatt + regionskatt + begravningsavgift ± kyrkoavgift).

Rounding rule: fractional part ≤0.50 rounds down, ≥0.51 rounds up to determine the table number.

## Column system

Each table contains 6 columns for different employee categories:

| Column | Applies to |
|---|---|
| 1 | Standard employees under 66 (most common) |
| 2 | Pensioners 66+ |
| 3 | Workers 66+ with förhöjt jobbskatteavdrag |
| 4 | Sjuk-/aktivitetsersättning recipients under 66 |
| 5 | Other pension-qualifying income than salary (e.g. a-kassa, own arbetsskadelivränta) for people born 1938 or later |
| 6 | Pensions and other income that is not a base for allmän pensionsavgift and gives no jobbskatteavdrag, for people under 66 at year start |

## Implementation workflow

1. Download Skatteverket's annual skattesatser file (XLSX/TXT) mapping each kommun to its total rate
2. Determine the employee's folkbokföringskommun from November 1 of the prior year
3. Apply the rounding rule to get the table number
4. Select the correct column based on age and income type
5. Look up the monthly gross salary bracket to find the withholding amount

Skatteverket publishes tables as XLSX, TXT, and PDF, plus open data via the Utvecklarportal. The TXT files follow a fixed-format record structure described in a separate postbeskrivning document.

## Jämkning

Jämkning is a Skatteverket decision adjusting withholding up or down from the table amount. The employee provides a jämkningsbeslut to the employer, who must apply it instead of the table.

## Sidoinkomst

For secondary income (all employers other than the main one), withhold a flat 30% regardless of salary level.

## SINK

Särskild inkomstskatt för utomlands bosatta (SINK) is a final withholding tax on pay to people not resident in Sweden: 22.5% from 2026 (25% in 2025).

Employees may request förhöjt skatteavdrag (higher withholding) from their main employer without any Skatteverket decision. Lower withholding always requires a jämkning.

## State income tax

The brytpunkt is 660,400 SEK/year (~55,033 SEK/month) for 2026 at 20% above the threshold (skiktgräns 643,000 SEK after grundavdrag; brytpunkt 760,500 SEK for people who had turned 66 at year start). This is already built into the published tax tables, so no separate employer calculation is needed.