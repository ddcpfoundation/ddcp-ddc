// The exit status rule for every command. A command exits 0 when the state it
// exists to produce holds at the end: a transaction confirmed, an inspection
// printed without --broadcast, or nothing to do because the state already
// holds (Confidential Balances already active with the derived key, no pending
// credit to apply). It exits 1 when that state does not hold: a refusal, a
// typed-CONFIRM abort, a declined consent, or a stop because the account
// cannot do what was asked. A script reading the status can therefore tell an
// abort from a send. The entry's own usage refusals keep their status 2.
//
// A command returns EXIT_NOT_DONE at each print-and-return stop; a thrown
// refusal reaches the entry, which prints its sentence and sets the same 1.

export const EXIT_NOT_DONE = 1;

/** What a command's run function resolves to: EXIT_NOT_DONE at a stop, nothing when done. */
export type CommandOutcome = typeof EXIT_NOT_DONE | void;

/** Pure: the sentence the entry prints for a thrown error that no other reader recognizes. */
export function formatUnrecognizedFailure(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message.trim();
    return message.length > 0 ? message : "ddc: the command failed with an error that carries no message (" + err.name + ")";
  }
  return "ddc: the command failed: " + String(err);
}
