// Interactive typed-CONFIRM gate — the reusable stop-and-think primitive for
// consequential, irreversible admin sends. Introduced by I-7
// publish_attestation; reused by unshield.
// Unlike --broadcast, the operator must TYPE the word CONFIRM at an
// interactive prompt — it is not a flag, so it is not up-arrow-repeatable and
// does not land in shell history. Injectable at the command layer
// (deps.promptConfirm) so tests substitute a stub with no stdin mocking.
//
// NO KEYBOARD PRE-CHECK, DELIBERATELY. The y/n consent prompt below refuses
// when stdin is not a TTY; this one must not, because the word is also
// supplied on a pipe for scripted runs. What it DOES take from the y/n prompt is
// the close race: readline's question() never settles at end of input, so
// without it a run with nothing on stdin prints the announcement and then
// exits silently, having sent nothing and said nothing. End of input is a
// thrown refusal here, exactly as it is there.

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/** A prompt function: shows `message`, returns true iff the operator affirmed. */
export type ConfirmPrompt = (message: string) => Promise<boolean>;

/**
 * Pure decision: an operator's typed line is an affirmative confirm iff it is
 * exactly "CONFIRM" (surrounding whitespace ignored). Case-sensitive by
 * design — a deliberate barrier, not a yes/no convenience.
 */
export function isTypedConfirm(line: string): boolean {
  return line.trim() === "CONFIRM";
}

/**
 * The streams a typed-CONFIRM prompt talks to; a test passes PassThrough
 * streams here. Deliberately NOT the y/n prompt's YesNoStreams below: that
 * type carries isTTY because that prompt requires a keyboard, and this one
 * must work on a pipe. Two types, two contracts.
 */
export interface ConfirmStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Build a typed-CONFIRM prompt over the given streams: print `message`, read
 * ONE line, apply isTypedConfirm. Works both interactively (operator types)
 * and under a pipe (`printf 'CONFIRM\n' | ddc ...`), the latter for scripted
 * devnet exercises. The question is raced against the interface's close event,
 * so end of input — nothing piped and no keyboard, or a Ctrl-D mid-prompt — is
 * a thrown refusal rather than an unsettled promise. The race is safe for the
 * pipe: readline emits the buffered line before it emits close, so an answer
 * that arrived always settles first.
 */
export function createTypedConfirmPrompt(streams: ConfirmStreams): ConfirmPrompt {
  return async (message) => {
    const rl = createInterface({ input: streams.input, output: streams.output });
    const closed = new Promise<null>((resolve) => {
      rl.once("close", () => resolve(null));
    });
    try {
      const answer = await Promise.race([rl.question(message), closed]);
      if (answer === null) {
        throw new Error(
          "input closed before the word was typed; nothing was confirmed",
        );
      }
      return isTypedConfirm(answer);
    } finally {
      rl.close();
    }
  };
}

/** The real prompt over the process streams; commands take it via deps and tests inject a stub. */
export const promptTypedConfirm: ConfirmPrompt = createTypedConfirmPrompt({
  input,
  output,
});


/**
 * The question of record for the typed-CONFIRM gate, printed byte for byte by
 * every command that carries it. Shared here rather than restated per command:
 * the word the CLI teaches is one word, and a second wording would weaken it.
 */
export const TYPED_CONFIRM_QUESTION =
  "Type CONFIRM to send this transaction, or anything else to abort: ";

/** The cheap register: printed when the gate returns false, before anything is sent. */
export const CONFIRM_ABORTED_BEFORE_SEND =
  "ABORTED " + String.fromCharCode(0x2014) + " the word CONFIRM was not typed. Nothing was sent and no fee was paid.";

// ---------------------------------------------------------------------------
// y/n CONSENT prompt — the user-command counterpart of the typed CONFIRM gate
// above. Introduced by setup-privacy; reused by every user command that carries
// the pre-flight prompt.

/** A yes/no consent prompt: shows `message`, returns true iff the operator answered y. */
export type YesNoPrompt = (message: string) => Promise<boolean>;

/**
 * Pure decision for ONE answer line: y/Y is yes, n/N is no, and anything else —
 * including the empty line that Enter alone produces — is undecided and is
 * asked again. There is deliberately no answer Enter can give.
 */
export function parseYesNo(line: string): "yes" | "no" | "again" {
  const t = line.trim();
  if (t === "y" || t === "Y") return "yes";
  if (t === "n" || t === "N") return "no";
  return "again";
}

/** The streams a y/n prompt talks to; a test passes PassThrough streams here. */
export interface YesNoStreams {
  input: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  output: NodeJS.WritableStream;
}

/**
 * Build a y/n prompt over the given streams. Re-asks until y or n. Both guards
 * are fixed: (1) the input must be a keyboard — with no TTY the
 * prompt refuses BEFORE asking, because readline's question() never settles at
 * end of input and the process would exit 13 having printed nothing; (2) the
 * question is raced against the interface's close event, so a Ctrl-D
 * mid-prompt is a printed refusal. The typed-CONFIRM prompt above carries the
 * second guard and deliberately not the first: it must work on a pipe.
 */
export function createYesNoPrompt(streams: YesNoStreams): YesNoPrompt {
  return async (message) => {
    if (streams.input.isTTY !== true) {
      throw new Error(
        "this prompt needs a keyboard: stdin is not an interactive terminal, so the question cannot be asked",
      );
    }
    const rl = createInterface({ input: streams.input, output: streams.output });
    let isClosed = false;
    const closed = new Promise<null>((resolve) => {
      rl.once("close", () => {
        isClosed = true;
        resolve(null);
      });
    });
    const closedError = () =>
      new Error("input closed before an answer was given; nothing was done");
    try {
      for (;;) {
        if (isClosed) throw closedError();
        const answer = await Promise.race([rl.question(message), closed]);
        if (answer === null) throw closedError();
        const decision = parseYesNo(answer);
        if (decision === "yes") return true;
        if (decision === "no") return false;
        streams.output.write("Please answer y or n.\n");
      }
    } finally {
      rl.close();
    }
  };
}

/** The real prompt over the process streams; commands take it via deps and tests inject a stub. */
export const promptYesNo: YesNoPrompt = createYesNoPrompt({ input, output });
