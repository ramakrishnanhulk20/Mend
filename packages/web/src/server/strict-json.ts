/**
 * A strict JSON check that refuses repeated keys, run before JSON.parse.
 *
 * JSON.parse keeps the last of two equal keys silently, so a signed body could be
 * read one way by a verifier and another way by us. This tokenizer follows the JSON
 * grammar JSON.parse uses (RFC 8259) and compares keys after decoding escapes,
 * exactly as JSON.parse would produce them, so "a" and "a" are the same key.
 * It is iterative with a depth cap, so hostile nesting cannot exhaust the stack.
 */

export type JsonProblem = "syntax" | "duplicate_key" | "too_deep";

export const MAX_JSON_DEPTH = 64;

export class StrictJsonError extends Error {
  readonly problem: JsonProblem;

  constructor(problem: JsonProblem) {
    super(`JSON refused: ${problem}`);
    this.name = "StrictJsonError";
    this.problem = problem;
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function isDigit(code: number): boolean {
  return code >= DIGIT_0 && code <= DIGIT_9;
}

function isHex(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

class Scanner {
  readonly text: string;
  i = 0;

  constructor(text: string) {
    this.text = text;
  }

  code(): number {
    return this.i < this.text.length ? this.text.charCodeAt(this.i) : -1;
  }

  skipWhitespace(): void {
    for (;;) {
      const c = this.code();
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return;
      this.i += 1;
    }
  }

  /** Reads a string starting at the opening quote; returns its decoded value or null. */
  readString(): string | null {
    const text = this.text;
    this.i += 1;
    let decoded = "";
    let runStart = this.i;
    for (;;) {
      const c = this.code();
      if (c === -1 || c < 0x20) return null;
      if (c === QUOTE) {
        decoded += text.slice(runStart, this.i);
        this.i += 1;
        return decoded;
      }
      if (c !== BACKSLASH) {
        this.i += 1;
        continue;
      }
      decoded += text.slice(runStart, this.i);
      const escape = text[this.i + 1];
      if (escape === "u") {
        for (let k = 2; k < 6; k += 1) {
          if (!isHex(text.charCodeAt(this.i + k))) return null;
        }
        // One UTF-16 unit per escape, as JSON.parse does, so escaped surrogate pairs
        // compare equal to the same character written raw.
        decoded += String.fromCharCode(Number.parseInt(text.slice(this.i + 2, this.i + 6), 16));
        this.i += 6;
      } else if (escape !== undefined && Object.hasOwn(SIMPLE_ESCAPES, escape)) {
        decoded += SIMPLE_ESCAPES[escape];
        this.i += 2;
      } else {
        return null;
      }
      runStart = this.i;
    }
  }

  readNumber(): boolean {
    if (this.code() === MINUS) this.i += 1;
    if (this.code() === DIGIT_0) {
      this.i += 1;
    } else if (isDigit(this.code())) {
      while (isDigit(this.code())) this.i += 1;
    } else {
      return false;
    }
    if (this.code() === DOT) {
      this.i += 1;
      if (!isDigit(this.code())) return false;
      while (isDigit(this.code())) this.i += 1;
    }
    if (this.code() === 0x65 || this.code() === 0x45) {
      this.i += 1;
      if (this.code() === PLUS || this.code() === MINUS) this.i += 1;
      if (!isDigit(this.code())) return false;
      while (isDigit(this.code())) this.i += 1;
    }
    return true;
  }

  readWord(word: string): boolean {
    if (!this.text.startsWith(word, this.i)) return false;
    this.i += word.length;
    return true;
  }
}

type Frame = { readonly keys: Set<string> | null };

function readKey(scanner: Scanner, keys: Set<string>): JsonProblem | null {
  scanner.skipWhitespace();
  if (scanner.code() !== QUOTE) return "syntax";
  const key = scanner.readString();
  if (key === null) return "syntax";
  if (keys.has(key)) return "duplicate_key";
  keys.add(key);
  scanner.skipWhitespace();
  if (scanner.code() !== COLON) return "syntax";
  scanner.i += 1;
  return null;
}

/**
 * Why text is not acceptable JSON, or null if it is one JSON value with no repeated
 * key in any object at any depth and no more than maxDepth nested objects and arrays.
 * Covers the JSON grammar and key equality after escapes. Does not cover meaning: a
 * value that passes still needs schema validation.
 */
export function jsonProblem(text: string, maxDepth: number = MAX_JSON_DEPTH): JsonProblem | null {
  const scanner = new Scanner(text);
  const stack: Frame[] = [];
  let expectValue = true;
  for (;;) {
    scanner.skipWhitespace();
    const c = scanner.code();
    if (expectValue) {
      if (c === OPEN_OBJECT || c === OPEN_ARRAY) {
        if (stack.length >= maxDepth) return "too_deep";
        scanner.i += 1;
        scanner.skipWhitespace();
        const closing = c === OPEN_OBJECT ? CLOSE_OBJECT : CLOSE_ARRAY;
        if (scanner.code() === closing) {
          scanner.i += 1;
          expectValue = false;
          continue;
        }
        const frame: Frame = { keys: c === OPEN_OBJECT ? new Set<string>() : null };
        stack.push(frame);
        if (frame.keys !== null) {
          const problem = readKey(scanner, frame.keys);
          if (problem !== null) return problem;
        }
        continue;
      }
      let ok: boolean;
      if (c === QUOTE) ok = scanner.readString() !== null;
      else if (c === MINUS || isDigit(c)) ok = scanner.readNumber();
      else if (c === 0x74) ok = scanner.readWord("true");
      else if (c === 0x66) ok = scanner.readWord("false");
      else if (c === 0x6e) ok = scanner.readWord("null");
      else ok = false;
      if (!ok) return "syntax";
      expectValue = false;
      continue;
    }
    const top = stack.at(-1);
    if (top === undefined) {
      return c === -1 ? null : "syntax";
    }
    if (c === COMMA) {
      scanner.i += 1;
      if (top.keys !== null) {
        const problem = readKey(scanner, top.keys);
        if (problem !== null) return problem;
      }
      expectValue = true;
      continue;
    }
    if (c === (top.keys !== null ? CLOSE_OBJECT : CLOSE_ARRAY)) {
      scanner.i += 1;
      stack.pop();
      continue;
    }
    return "syntax";
  }
}

/**
 * JSON.parse, only after jsonProblem() finds nothing wrong with the same text.
 * Throws StrictJsonError naming the problem.
 */
export function parseStrictJson(text: string, maxDepth: number = MAX_JSON_DEPTH): unknown {
  const problem = jsonProblem(text, maxDepth);
  if (problem !== null) throw new StrictJsonError(problem);
  try {
    return JSON.parse(text);
  } catch {
    throw new StrictJsonError("syntax");
  }
}
