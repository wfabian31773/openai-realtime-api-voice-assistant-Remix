/**
 * THE WORDS AROUND A NAME — v180, one list for two readers.
 *
 * `nameFromTheRecording` lets these stand between the two halves of one
 * spoken name ("My name is Jane, my last name is Lake", "Jones, first name
 * Mary", "mi apellido es"). The request sweep counts a caller turn made of
 * nothing but these (once names, dates and spelled letters are gone) as
 * identity, so a caller who only introduced themselves this way is still
 * `identity-only` (Codex P2 on #431: "last" was left over, and the re-decided
 * sweep filed a ticket with no request in it).
 *
 * v193: ONLY when they are all that is left of the turn. v180 subtracted them
 * from every turn, so "His last visit was cancelled", said in answer to a name
 * question, shrank to a name-sized answer and was skipped (review of #431).
 */
export const NAME_SCAFFOLDING: readonly string[] = [
  "my", "her", "his", "their", "the", "and", "is", "its", "last", "first", "name", "names", "surname",
  "patient", "patients", "that", "thats", "spelled", "spell", "spelling",
  "mi", "su", "es", "y", "apellido", "nombre", "se", "escribe",
];
