#!/usr/bin/env python3
"""Rename the reference currency placeholder in a fork of this repository.

The reference names its currency with the placeholder "ddc" (lower case),
"DDC" (upper case) and "Ddc" (inside identifiers such as formatDdcAmount).
A fork replaces all three with its own currency code. "ddcp", the name of the
protocol, never changes, so a "ddc" followed by "p" or "P" is left alone, as
is any "ddc" inside a longer run of letters and digits (an address, a hash).

Usage, from the repository root of a fork:
  scripts/rename-currency.py XYZ          rename to XYZ, then check
  scripts/rename-currency.py --check      report any placeholder left, change nothing

Only files tracked by git are touched, and never this script. A line that
carries the marker "rename-currency: keep" is left unchanged: it holds data
captured from the reference mint, which a fork replaces with its own test
data rather than by renaming, or a sentence about the placeholder itself.
After renaming, the script searches again and exits 1 if any placeholder is
left outside such lines.

It then lists, for the fork to check by hand, every line it left unchanged
because of the marker and every line of the test files (*.test.ts and
program/tests/) that names an address or key of the Foundation's devnet
demonstration; there such a value stands for any address and may stay. It
also lists every line outside the test files that still names one, and exits
1 while any such line is left: a fork replaces them with its own
deployment's values, or marks a line it keeps on purpose. Run both test
suites afterwards.
"""
import re
import subprocess
import sys

MARKER = "rename-currency: keep"
PATTERNS = [
    # lower case: not inside a longer word, not "ddcp"
    (re.compile(r"(?<![A-Za-z0-9])ddc(?![a-z0-9pP])"), "lower"),
    # upper case: not inside a longer upper-case word, not "DDCP"
    (re.compile(r"(?<![A-Za-z0-9])DDC(?![A-Z0-9P])|(?<=[a-z0-9_])DDC(?![A-Z0-9P])"), "upper"),
    # capitalized, at a word start or after a lower-case letter or digit (camelCase)
    (re.compile(r"(?<![A-Za-z0-9])Ddc(?![a-z0-9p])|(?<=[a-z0-9])Ddc(?![a-z0-9p])"), "title"),
]


SELF = "scripts/rename-currency.py"

# Every address and key of the Foundation's devnet demonstration: those in
# the README's two instance tables and the command-line tool's two durable-nonce
# accounts. The program address comes first. A test in the command-line suite
# (cli/src/demonstration-addresses.test.ts) fails while this list misses one.
DEMONSTRATION = (
    "Bn36ThBHETRi1qBGSauPmocKRFfzFGvdvnAn7SAb1Jp",  # program
    "8J6DmzQ8ZFLpAgnELpqtRmbL9ve6AB3nmGhxAG7bcWvR",  # program upgrade authority (deploy key)
    "9RTSRMFRCLKHLEzyKcTEypz5R45tPUctNMLir98y1iRa",  # reference mint
    "7yJKCjUP93pH5THrCvte6CjVCcATWDnPg1UDdokiMXVP",  # reserve statement (PDA-2)
    "GN8i7WtFJvrgeu9uVsS8JVsH7idzWw8La7NQf6Wn7y9B",  # mint state and mint authority (PDA-1)
    "48y5dnb9g3FhZJKtvVzMV9qRUd8Jz7aYeXvsmNtBVEJu",  # transfer fee configuration authority (PDA-3)
    "J5aokYFjfeyWsXAzdXQGfQoUrx5Xc4WDc6BCVjyeopAQ",  # withdraw-withheld authority
    "CxVb4kZeyyzDfJqTAQVuhHomAb5JoAkH74eZdrCDZhzW",  # Confidential Transfer fee authority
    "dvHT4Aldldboa/o8o0RZLCo09MLXx2UlOwPTZFcNCkM=",  # withheld-fee ElGamal public key
    "4QVtXiCKrhnPjHJenhPic25MKz5gvHSz6cfegpeh9oUe",  # metadata pointer authority
    "BKBuFZExXGBH12Kt2vHxLduuKPGQZy1yL3E9rKfZPEKv",  # metadata update authority
    "5AygggFgzsTFFbuQNYsxWoLRyJYpPwSzTWq3ZHdZStPV",  # issuer
    "BHbcbfSXvxU2toUw5R6YEqWNcCb6PpYaLd1QdoCPyUSU",  # operator
    "8Zff6SFUwZnS54qt2JiWodWQ2Hhrg25j3sWko6UzWUSx",  # reserve
    "Aqd1EFGrzMzoX9A1KKnNL99xGM26Sa36mkwVvd1H9dqE",  # issuer durable-nonce account
    "Sd4959ZK3E2hnyt9o2RHLVxe9NX4Z7Z2ZPcWjaNsnMf",  # operator durable-nonce account
)


def is_test_file(name):
    return name.endswith(".test.ts") or name.startswith("program/tests/")


def tracked_text_files():
    out = subprocess.run(["git", "ls-files", "-z"], check=True, capture_output=True).stdout
    for name in out.decode("utf-8").split("\0"):
        if not name or name == SELF:
            continue
        try:
            with open(name, "rb") as f:
                data = f.read()
        except (IsADirectoryError, FileNotFoundError):
            continue
        if b"\0" in data:
            continue
        try:
            yield name, data.decode("utf-8")
        except UnicodeDecodeError:
            continue


def leftovers():
    found = []
    for name, text in tracked_text_files():
        for number, line in enumerate(text.split("\n"), 1):
            if MARKER in line:
                continue
            for pattern, _ in PATTERNS:
                if pattern.search(line):
                    found.append(f"{name}:{number}")
                    break
    return found


def kept_lines():
    found = []
    for name, text in tracked_text_files():
        for number, line in enumerate(text.split("\n"), 1):
            if MARKER in line:
                found.append(f"{name}:{number}")
    return found


def demonstration_in_tests():
    found = []
    for name, text in tracked_text_files():
        if not is_test_file(name):
            continue
        for number, line in enumerate(text.split("\n"), 1):
            if MARKER in line:
                continue
            if any(value in line for value in DEMONSTRATION):
                found.append(f"{name}:{number}")
    return found


def demonstration_left():
    found = []
    for name, text in tracked_text_files():
        if is_test_file(name):
            continue
        for number, line in enumerate(text.split("\n"), 1):
            if MARKER in line:
                continue
            if any(value in line for value in DEMONSTRATION):
                found.append(f"{name}:{number}")
    return found


def rename(code):
    forms = {"lower": code.lower(), "upper": code.upper(), "title": code[0].upper() + code[1:].lower()}
    changed = 0
    for name, text in tracked_text_files():
        lines = text.split("\n")
        new = []
        for line in lines:
            if MARKER not in line:
                for pattern, form in PATTERNS:
                    line = pattern.sub(forms[form], line)
            new.append(line)
        result = "\n".join(new)
        if result != text:
            with open(name, "w", encoding="utf-8", newline="") as f:
                f.write(result)
            changed += 1
    return changed


def main(argv):
    if len(argv) != 2:
        print(__doc__.strip())
        return 2
    if argv[1] != "--check":
        code = argv[1]
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]{1,9}", code) or code.lower().startswith("ddc"):
            print(f'refused: "{code}" is not a currency code of 2 to 10 letters and digits starting with a letter, other than the placeholder')
            return 2
        print(f"renamed in {rename(code)} files")
    left = leftovers()
    for place in left:
        print(f"placeholder left: {place}")
    print(f"placeholder occurrences left: {len(left)}")
    kept = kept_lines()
    for place in kept:
        print(f"kept line, check by hand: {place}")
    print(f"kept lines: {len(kept)}")
    tests = demonstration_in_tests()
    for place in tests:
        print(f"test line left alone, check by hand: {place}")
    print(f"test lines left alone: {len(tests)}")
    demo = demonstration_left()
    for place in demo:
        print(f"demonstration address left: {place}")
    print(f"demonstration address lines left: {len(demo)}")
    return 1 if left or demo else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
