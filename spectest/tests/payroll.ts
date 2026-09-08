/**
 * Payroll: one employee, one salary run.
 *
 * The arithmetic is the whole point, and it is arithmetic with statutory
 * constants in it. For a 40 000 kr monthly salary in Stockholm the run must
 * produce, per the standard BAS pattern:
 *
 *   7210  D 40 000        gross
 *   2710  K  7 900        skatteavdrag, table 31 column 1
 *   1930  K 32 100        net paid out
 *   7510  D 12 568        arbetsgivaravgifter, 40 000 × 31,42 %
 *   2731  K 12 568
 *   7290  D  4 800        semesteravsättning, procentregeln 12 %
 *   2920  K  4 800
 *   7519  D  1 508,16     avgifter on the accrual, 4 800 × 31,42 %
 *   2940  K  1 508,16
 *
 * 31,42 % has been the total rate since 2009 and 12 % is procentregeln, so a
 * change in either of those numbers is either a law change or a bug, and both
 * are worth failing a test over.
 *
 * The skattetabell is not typed: it is derived from the employee's kommun.
 * Stockholm gives table 31 at 30,62 %.
 */
import { expect } from "@specific.dev/spectest";
import { env, APP_URL } from "../index";
import { enrolMfa } from "./mfa";

const EMPLOYEE = {
  firstName: "Anna",
  lastName: "Andersson",
  // Valid Luhn checksum: a fabricated one is rejected before it reaches the API.
  personnummer: "19850101-0006",
  monthlySalary: "40000",
  municipality: "Stockholm",
  taxTable: 31,
  taxColumn: 1,
};

export const createEmployee = env.test(
  "add an employee and derive their tax table from the kommun",
  { dependsOn: enrolMfa },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/salary/employees/new`);
    await expect(b.getByText("Folkbokföringskommun")).toBeVisible({ timeout: 25000 });

    await b.locator("#first_name").fill(EMPLOYEE.firstName);
    await b.locator("#last_name").fill(EMPLOYEE.lastName);
    await b.locator("#personnummer").fill(EMPLOYEE.personnummer);
    await b.locator("#employment_start").fill("2026-01-01");
    await b.locator("#monthly_salary").fill(EMPLOYEE.monthlySalary);

    // Typing the kommun opens a list of plain buttons, each showing the table
    // it implies. Picking one derives the table and the municipal rate; there
    // is no field to type the table into unless you opt into overriding it.
    await b.locator("#tax_municipality").fill(EMPLOYEE.municipality);
    await b.getByRole("button", { name: /^Stockholm/ }).click();
    await expect(b.getByText(/Stockholm · 30,62 %/)).toBeVisible();

    // A bank account is required before a run can pay anyone.
    await b.locator("#clearing_number").fill("8000");
    await b.locator("#bank_account_number").fill("1234567");

    await b.getByRole("button", { name: "Spara", exact: true }).click();

    const employees = await ctx.poll("the employee is created", async () => {
      const rows = await ctx.svc.supabase.sql<{
        first_name: string;
        last_name: string;
        monthly_salary: string;
        tax_table_number: number;
        tax_column: number;
      }>`
        select first_name, last_name, monthly_salary::text as monthly_salary,
               tax_table_number, tax_column
        from public.employees`;
      return rows.unwrap().length === 1 ? rows : null;
    });

    expect(employees[0]?.first_name).toBe(EMPLOYEE.firstName);
    expect(employees[0]?.monthly_salary).toBe(EMPLOYEE.monthlySalary);
    // Derived, not entered.
    expect(employees[0]?.tax_table_number).toBe(EMPLOYEE.taxTable);
    // Column 1 is the ordinary employee under 66.
    expect(employees[0]?.tax_column).toBe(EMPLOYEE.taxColumn);

    return ctx.parent;
  },
);

export const salaryRunComputesTheStatutoryAmounts = env.test(
  "a salary run computes tax, avgifter and holiday accrual",
  { dependsOn: createEmployee },
  async (ctx) => {
    const b = await ctx.browser();

    await b.goto(`${APP_URL}/salary`);
    // Two buttons carry this label on the page; either starts the run.
    await b.getByRole("button", { name: "Starta lönekörning" }).first().click();

    await expect(b.getByText("FÖRHANDSGRANSKNING — VERIFIKATIONER")).toBeVisible({
      timeout: 30000,
    });

    // The run states the rate it applied rather than only the result, which is
    // what makes it checkable by someone who knows the law but not the code.
    await expect(b.getByText(/Avgiftskategori: Standard 31,42 %/)).toBeVisible();
    await expect(
      b.getByText(/Semesteravsättning \(procentregeln 12 %\)/),
    ).toBeVisible();

    // The proposed verifikat, account by account.
    const preview = b.locator("body");
    await expect(preview).toContainText("7210");
    await expect(preview).toContainText("2710");
    await expect(preview).toContainText("7510");
    await expect(preview).toContainText("2731");
    await expect(preview).toContainText("7290");
    await expect(preview).toContainText("2920");
    await expect(preview).toContainText("7519");
    await expect(preview).toContainText("2940");

    // The amounts. Regexes because Swedish thousands separators are
    // non-breaking spaces, so a literal " " matches text that renders
    // identically and is not the same string.
    await expect(
      preview,
      "arbetsgivaravgifter are 31,42 % of the gross",
    ).toContainText(/12\s568 kr/);
    // Net pay: gross less the table-31 deduction of 7 900.
    await expect(preview).toContainText(/32\s100 kr/);
    // Holiday accrual at 12 %, and 31,42 % of that again.
    await expect(preview).toContainText(/4\s800 kr/);
    await expect(preview).toContainText(/1\s508,16 kr/);

    // Nothing is booked by previewing: the run is still a proposal.
    const entries = await ctx.svc.supabase.sql<{ n: number }>`
      select count(*)::int as n from public.journal_entries`;
    expect(entries[0]?.n).toBe(0);

    return ctx.parent;
  },
);
