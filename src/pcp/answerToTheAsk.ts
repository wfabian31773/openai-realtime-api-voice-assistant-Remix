/**
 * WHAT THE CALLER SAID WHEN THE AGENT ASKED WHAT THEY NEED (v205).
 *
 * v204 asks a caller who has only asked for a person what they need ("I can
 * take a message for the team. What can I help you with today?"), and until
 * the caller's answer is filed the PCP teardown floor files nothing. The
 * model clears the ask when it files the answer (`callerStatedARequest:
 * true`). When the caller answers and the call then ends before the model
 * files it (the agent stalls and the dead-air watchdog ends the call, the
 * silence ladder, the duration ceiling, the agent's own hangup), the answer
 * was lost. Wayne, 2026-11-11.
 *
 * This reads the answer back from the call's timed turns. It is the answer
 * to that one question, read by position, not a request detector (standing
 * instruction 3): the window opens on the first agent line written after the
 * ask was noted, which is the ask itself, and closes on the next agent line.
 * A caller line in that window is an answer to it.
 *
 * An answer that only asks for a person again ("Just a representative,
 * please"), only gives the caller's own name, organisation or role, or is
 * filler, is not a request: the v204 rule stands and nothing is filed. What
 * is left after those words is what a staffer can route.
 */
import { PERSON_NOUN_WORDS } from './explicitAsk';
import { saidMoreThanTheirOwnIdentity } from '../runtime/requestSweep';

export interface TeardownTurn {
  role: 'caller' | 'agent';
  text: string;
  /** Epoch ms when the line was first written (the transcript log's time). */
  atMs: number;
}

/**
 * The words around an ask for a person, which say nothing about what the
 * call is for. The nouns themselves come from `explicitAsk.ts`.
 */
const ASK_FOR_A_PERSON_WORDS: ReadonlySet<string> = new Set([
  'speak', 'talk', 'talking', 'connect', 'transfer', 'put', 'through', 'get',
  'me', 'us', 'them', 'him', 'her', 'you', 'your', 'our', 'let', 'just',
  'want', 'wants', 'wanted', 'wanna', 'need', 'needs', 'needed', 'like',
  'would', 'could', 'can', 'may', 'will', 'do', 'have', 'be', 'please', 'live',
  'real', 'actual', 'being', 'an', 'to', 'with', 'for', 'or', 'anyone',
  'anybody', 'call', 'calling', 'back', 'from', 'about', 'regarding',
  'something', 'anything', 'question', 'questions', 'there', 'now', 'right',
  'away', 'go', 'ahead', 'sure', 'fine', 'alright', 'all', 'again', 'over',
  'phone', 'myself', 'help', 'line', 'hold',
]);

/**
 * True when the line says more than an ask for a person and the caller's own
 * identity. `known` is every name, organisation and role the intake holds.
 */
export function saysMoreThanAnAskForAPerson(line: string, known: ReadonlyArray<string | undefined>): boolean {
  const left = line
    .toLowerCase()
    .replace(/[.,!?¿¡'"’-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !PERSON_NOUN_WORDS.has(w) && !ASK_FOR_A_PERSON_WORDS.has(w))
    .join(' ');
  if (!left) return false;
  return saidMoreThanTheirOwnIdentity(`CALLER: ${left}`, {
    firstName: known.filter(Boolean).join(' '),
  });
}

/**
 * The caller's answer to the v204 ask, as the lines a staffer should read;
 * empty when there is none (no turns, the ask never spoken, nothing said in
 * its window, or only an ask for a person and identity).
 */
export function answerToTheNoRequestAsk(
  turns: ReadonlyArray<TeardownTurn> | undefined,
  askedAtMs: number,
  known: ReadonlyArray<string | undefined>,
): string[] {
  if (!turns?.length) return [];
  let open = false;
  let opened = false;
  const answer: string[] = [];
  for (const turn of turns) {
    if (turn.role === 'agent') {
      if (turn.atMs < askedAtMs) continue;
      if (!opened) {
        opened = true;
        open = true;
        continue;
      }
      if (open) break;
      continue;
    }
    if (!open) continue;
    const text = turn.text.trim();
    if (text && saysMoreThanAnAskForAPerson(text, known)) answer.push(text);
  }
  return answer;
}
