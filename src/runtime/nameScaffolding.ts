/**
 * THE WORDS AROUND A NAME — v180, one list for two readers.
 *
 * `nameFromTheRecording` lets these stand between the two halves of one
 * spoken name ("My name is Jane, my last name is Lake", "Jones, first name
 * Mary", "mi apellido es"). The request sweep counts the same words as
 * identity, not as a request, so a caller who only introduced themselves this
 * way is still `identity-only` (Codex P2 on #431: "last" was left over, and
 * the re-decided sweep filed a ticket with no request in it).
 */
export const NAME_SCAFFOLDING: readonly string[] = [
  "my", "her", "his", "their", "the", "and", "is", "its", "last", "first", "name", "names", "surname",
  "patient", "patients", "that", "thats", "spelled", "spell", "spelling",
  "mi", "su", "es", "y", "apellido", "nombre", "se", "escribe",
];
