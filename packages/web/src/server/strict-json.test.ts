// Covers the duplicate-key and grammar check in strict-json.ts, including agreement
// with JSON.parse on valid and invalid text and a seeded random sweep. Does NOT cover:
// schema checks on the parsed value (webhooks.test.ts), or text over the body size cap.
import { describe, expect, it } from "vitest";
import { jsonProblem, MAX_JSON_DEPTH, parseStrictJson, StrictJsonError } from "./strict-json";

function parsesWithJsonParse(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Small deterministic generator (mulberry32) so a failure is reproducible from the seed.
function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const KEY_POOL = ["id", "event_type", "resource", "a", "b", "é", "😀", "__proto__", "x\"y", "tab\t", " "];

function randomValue(next: () => number, depth: number): unknown {
  const roll = next();
  if (depth > 4 || roll < 0.35) {
    const leaf = [null, true, false, 0, -12.5e3, 1e-7, "text", "quote\"back\\slash", "\u0000\u001f", "日本"];
    return leaf[Math.floor(next() * leaf.length)];
  }
  if (roll < 0.6) {
    return Array.from({ length: Math.floor(next() * 4) }, () => randomValue(next, depth + 1));
  }
  const object: Record<string, unknown> = {};
  const count = Math.floor(next() * 5);
  for (let k = 0; k < count; k += 1) {
    Object.defineProperty(object, KEY_POOL[Math.floor(next() * KEY_POOL.length)], {
      value: randomValue(next, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return object;
}

// Writes a key's characters as \uXXXX escapes, so the text differs but the decoded key does not.
function escapeAll(key: string): string {
  let escaped = "";
  for (let k = 0; k < key.length; k += 1) {
    escaped += `\\u${key.charCodeAt(k).toString(16).padStart(4, "0")}`;
  }
  return `"${escaped}"`;
}

describe("jsonProblem: duplicate keys", () => {
  it.each([
    ['{"a":1,"a":2}', "at the top level"],
    ['{"x":{"a":1,"b":2,"a":3}}', "inside a nested object"],
    ['[1,{"k":[{"a":1,"a":1}]}]', "inside an object inside arrays"],
    ['{"a":1,"\\u0061":2}', "when one copy is written as an escape"],
    ['{"\\u00e9":1,"é":2}', "for a non-ASCII key written two ways"],
    ['{"\\ud83d\\ude00":1,"😀":2}', "for an escaped surrogate pair and the raw character"],
    ['{"a\\/b":1,"a/b":2}', "for an escaped solidus"],
    ['{"__proto__":1,"__proto__":2}', "for __proto__"],
    ['{"id":"WH-1","resource":{"id":"X"},"id":"WH-2"}', "for a webhook id repeated after a nested object"],
  ])("refuses %s %s", (text) => {
    expect(jsonProblem(text)).toBe("duplicate_key");
  });

  it.each([
    ['{"a":1,"b":{"a":2}}', "the same key at different depths"],
    ['[{"a":1},{"a":2}]', "the same key in sibling objects"],
    ['{"a":1,"A":2}', "keys that differ only in case"],
    ['{"a ":1,"a":2}', "keys that differ by a space"],
  ])("accepts %s (%s)", (text) => {
    expect(jsonProblem(text)).toBeNull();
  });
});

describe("jsonProblem agrees with JSON.parse on grammar", () => {
  const corpus = [
    "{}", "[]", '""', "0", "-0", "1.5e+10", "-1E-2", "true", "false", "null", ' \t\n\r{ "a" : [ 1 , 2 ] } \n',
    '"\\u2028 raw  "', '"\\"\\\\\\/\\b\\f\\n\\r\\t"', '"lone \\ud800 surrogate"', '"raw lone \ud800"', '{"":0}',
    "", " ", "01", "1.", ".5", "-", "+1", "1e", "1e+", "0x10", "NaN", "Infinity", "-Infinity", "tru", "nul", "True",
    '{"a":1,}', "[1,]", "[,1]", '{"a" 1}', '{a:1}', "{'a':1}", '"\\x41"', '"\\u12"', '"\\u12G4"', '"tab\there"',
    '"newline\nhere"', '"unterminated', "﻿{}", "{} ", "{} {}", "[1] 2", "// c\n{}", "{/*c*/}", '{"a":1}}',
    "[[]", "[]]", '{"a":[1}', " {}", '"\\uD83D\\uDE00"', "1 2", "[1 2]", '{"a":1 "b":2}',
  ];

  it.each(corpus.map((text) => [JSON.stringify(text), text]))("%s", (_label, text) => {
    const problem = jsonProblem(text);
    expect(problem === null).toBe(parsesWithJsonParse(text));
    if (problem !== null) expect(problem).toBe("syntax");
  });

  it("matches JSON.parse on 3,000 random valid documents and their one-character mutations", () => {
    const next = randomSource(20_261_020);
    const alphabet = '{}[]",:\\0123456789-+.eEtrufalsn \t\nu"a';
    for (let round = 0; round < 3_000; round += 1) {
      const text = JSON.stringify(randomValue(next, 0), null, next() < 0.3 ? 2 : undefined) ?? "null";
      expect(jsonProblem(text)).toBeNull();

      const at = Math.floor(next() * text.length);
      const replacement = alphabet[Math.floor(next() * alphabet.length)];
      const mutated = text.slice(0, at) + replacement + text.slice(at + 1);
      // The check stops at the first problem, so a repeated key seen before a later
      // syntax error is reported as duplicate_key; JSON.parse refuses that text too.
      const problem = jsonProblem(mutated);
      if (problem === null) expect(parsesWithJsonParse(mutated)).toBe(true);
      if (problem === "syntax") expect(parsesWithJsonParse(mutated)).toBe(false);
      if (parsesWithJsonParse(mutated)) expect(problem === null || problem === "duplicate_key").toBe(true);
    }
  });

  it("finds a key repeated in escaped form anywhere in random documents", () => {
    const next = randomSource(48);
    for (let round = 0; round < 500; round += 1) {
      const key = KEY_POOL[Math.floor(next() * KEY_POOL.length)];
      const inner = JSON.stringify(randomValue(next, 2)) ?? "null";
      const text = `{"wrap":[{${JSON.stringify(key)}:${inner},"other":1,${escapeAll(key)}:0}]}`;
      expect(parsesWithJsonParse(text)).toBe(true);
      expect(jsonProblem(text)).toBe("duplicate_key");
    }
  });
});

describe("jsonProblem: depth", () => {
  it("accepts nesting up to the cap and refuses one more", () => {
    expect(MAX_JSON_DEPTH).toBe(64);
    expect(jsonProblem("[".repeat(64) + "]".repeat(64))).toBeNull();
    expect(jsonProblem("[".repeat(65) + "]".repeat(65))).toBe("too_deep");
    expect(jsonProblem('{"a":'.repeat(65) + "1" + "}".repeat(65))).toBe("too_deep");
  });

  it("refuses 200,000 open brackets quickly without exhausting the stack", () => {
    const started = performance.now();
    expect(jsonProblem("[".repeat(200_000))).toBe("too_deep");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("parseStrictJson", () => {
  it("returns what JSON.parse returns", () => {
    const text = '{"id":"WH-1","resource":{"amount":{"value":"1.00"}},"list":[1,2.5,null]}';
    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
  });

  it("names the problem", () => {
    for (const [text, problem] of [
      ['{"a":1,"a":2}', "duplicate_key"],
      ["{", "syntax"],
      ["[".repeat(70), "too_deep"],
    ] as const) {
      const error = (() => {
        try {
          parseStrictJson(text);
        } catch (caught) {
          return caught;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(StrictJsonError);
      expect((error as StrictJsonError).problem).toBe(problem);
    }
  });

  it("keeps __proto__ as plain data and pollutes nothing", () => {
    const parsed = parseStrictJson('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
    expect(Object.hasOwn(parsed as object, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});
