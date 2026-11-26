/**
 * One CSV cell, safe to open in a spreadsheet.
 *
 * Quoting keeps commas, quotes and line breaks inside the cell, but it does
 * not stop Excel or Google Sheets from running a cell that starts with `=`,
 * `+`, `-` or `@` as a formula. The urgent-calls export carries text a caller
 * can influence (the caller-ID name, the agent's escalation reason), so a cell
 * that could be read as a formula is written with a leading apostrophe, which
 * makes the spreadsheet show it as text (Codex review of #525).
 *
 * A plain phone number or number (`+17145551234`, `-3`) is left as it is: it
 * cannot call anything, and an apostrophe in every phone cell would make the
 * column harder to use.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?[\d\s().-]+$/;

export function csvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  let str = String(val);
  if (FORMULA_START.test(str) && !PLAIN_NUMBER.test(str)) str = `'${str}`;
  if (/[",\r\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}
