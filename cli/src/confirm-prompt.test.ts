import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  createTypedConfirmPrompt,
  createYesNoPrompt,
  isTypedConfirm,
  parseYesNo,
} from "./confirm-prompt.js";

test("isTypedConfirm: exact CONFIRM is affirmative", () => {
  assert.equal(isTypedConfirm("CONFIRM"), true);
});

test("isTypedConfirm: surrounding whitespace is trimmed", () => {
  assert.equal(isTypedConfirm("  CONFIRM  "), true);
  assert.equal(isTypedConfirm("\tCONFIRM\n"), true);
});

test("isTypedConfirm: case-sensitive — lowercase/mixed is NOT affirmative", () => {
  assert.equal(isTypedConfirm("confirm"), false);
  assert.equal(isTypedConfirm("Confirm"), false);
});

test("isTypedConfirm: near-misses and empties are NOT affirmative", () => {
  assert.equal(isTypedConfirm("CONFIRMED"), false);
  assert.equal(isTypedConfirm("CONFIRM please"), false);
  assert.equal(isTypedConfirm("yes"), false);
  assert.equal(isTypedConfirm("y"), false);
  assert.equal(isTypedConfirm(""), false);
});

// ---------------------------------------------------------------------------
// y/n consent prompt. The real prompt is exercised here over PassThrough
// streams through the YesNoStreams seam. The typed-CONFIRM prompt has a
// ConfirmStreams seam of its own now; its tests are the third section below
// and reuse this section's `streams` helper.

// Lines are fed one at a time with a tick between them, the way a keyboard
// delivers them; a pre-ended stream would hand readline every line at once.
// gap: false removes the ticks, which is how a PIPE delivers — the line and the
// end of the stream land together, and the typed-CONFIRM race has to survive it.
function streams(lines: string[], tty: boolean, endAfter: boolean, gap = true) {
  const input = Object.assign(new PassThrough(), { isTTY: tty });
  const chunks: string[] = [];
  const output = new PassThrough();
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  void (async () => {
    for (const line of lines) {
      if (gap) await new Promise((r) => setTimeout(r, 5));
      input.write(line + "\n");
    }
    if (endAfter) {
      if (gap) await new Promise((r) => setTimeout(r, 5));
      input.end();
    }
  })();
  return { input, output, written: () => chunks.join("") };
}

test("parseYesNo: y/Y yes, n/N no, everything else again", () => {
  assert.equal(parseYesNo("y"), "yes"); assert.equal(parseYesNo(" Y "), "yes");
  assert.equal(parseYesNo("n"), "no"); assert.equal(parseYesNo("N"), "no");
  for (const s of ["", "yes", "no", "Y n", "1", "  "]) assert.equal(parseYesNo(s), "again");
});
test("a garbage line and an empty line are asked again; y then answers yes", async () => {
  const s = streams(["maybe", "", "y"], true, false);
  assert.equal(await createYesNoPrompt(s)("Q? [y/n] "), true);
  assert.equal((s.written().match(/Please answer y or n\./g) ?? []).length, 2);
});
test("n answers no", async () => {
  const s = streams(["n"], true, false);
  assert.equal(await createYesNoPrompt(s)("Q? [y/n] "), false);
});
test("no keyboard: refuses before asking, and the question is never written", async () => {
  const s = streams(["y"], false, false);
  await assert.rejects(() => createYesNoPrompt(s)("Q? [y/n] "), /needs a keyboard/);
  assert.equal(s.written(), "");
});
test("input closed mid-prompt is a printed refusal, not a hang", async () => {
  const s = streams([], true, true);
  await assert.rejects(() => createYesNoPrompt(s)("Q? [y/n] "), /input closed before an answer/);
});
test("a close after an undecided line is still a refusal", async () => {
  const s = streams(["maybe"], true, true);
  await assert.rejects(() => createYesNoPrompt(s)("Q? [y/n] "), /input closed before an answer/);
});

// ---------------------------------------------------------------------------
// typed-CONFIRM prompt. The word is read from ONE line, and the question is
// raced against the interface's close event. Two properties earn these tests:
// end of input must THROW rather than leave the promise unsettled, which is the
// silent exit-13 the y/n prompt's TTY pre-check avoids by a route this prompt
// cannot take; and a piped word must still win that race, since the pipe is the
// only non-interactive route this gate has.

test("createTypedConfirmPrompt: a piped CONFIRM answers true even when the line and the end of stream land in the same tick", async () => {
  const s = streams(["CONFIRM"], false, true, false);
  assert.equal(await createTypedConfirmPrompt(s)("Type CONFIRM: "), true);
});

test("createTypedConfirmPrompt: no keyboard is not a refusal — unlike the y/n prompt, this one must work off a pipe", async () => {
  const s = streams(["CONFIRM"], false, false);
  assert.equal(await createTypedConfirmPrompt(s)("Type CONFIRM: "), true);
});

test("createTypedConfirmPrompt: end of input with nothing typed throws, rather than leaving the promise unsettled", async () => {
  const s = streams([], true, true);
  await assert.rejects(
    () => createTypedConfirmPrompt(s)("Type CONFIRM: "),
    /input closed before the word was typed/,
  );
});

test("createTypedConfirmPrompt: a non-CONFIRM line is a plain false, and the stream closing after it does not turn that into a throw", async () => {
  for (const word of ["confirm", "CONFIRMED", "y", ""]) {
    const s = streams([word], true, true);
    assert.equal(await createTypedConfirmPrompt(s)("Type CONFIRM: "), false);
  }
});
