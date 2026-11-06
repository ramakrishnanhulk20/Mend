// Fails if a file in public/world carries a path or account name from the machine that made it.
// It reads raw bytes, so it catches text in any metadata format. Does NOT cover: camera, location
// or date tags, text stored compressed or in UTF-16 inside a file, or anything outside public/world.
import { readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORLD = fileURLToPath(new URL("../public/world", import.meta.url));
// A short user name could match image bytes by chance, so only a long one counts as a mark.
const USER_NAME = userInfo().username;
const MARKS = ["Users\\", "Users/", "D:/Projects", "D:\\Projects", "D:\\\\Projects", "scratchpad", ...(USER_NAME.length >= 6 ? [USER_NAME] : [])];

function marksIn(bytes: Buffer): string[] {
  return MARKS.filter((mark) => bytes.includes(mark));
}

function worldFiles(): string[] {
  return readdirSync(WORLD, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("public/world files", () => {
  it("finds files to check", () => {
    expect(worldFiles().length).toBeGreaterThan(0);
  });

  it("carry no machine path and no account name", () => {
    const found = worldFiles().flatMap((file) => marksIn(readFileSync(file)).map((mark) => `${file}: ${mark}`));
    expect(found).toEqual([]);
  });

  it("would catch every mark if one were there", () => {
    for (const mark of MARKS) {
      expect(marksIn(Buffer.concat([Buffer.from([0, 255]), Buffer.from(mark), Buffer.from([0])])), mark).toContain(mark);
    }
  });
});
