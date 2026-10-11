import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { expect } from "./expect.ts";
import {
  REQUIRED_SPRITE_KEYS,
  REQUIRED_STRING_KEYS,
  validateTheme,
  type ThemeManifest,
} from "../src/theme.ts";

// The pack guide is a promise about what the code requires. Documentation
// drifts silently, so the promise is checked: add a required key without
// documenting it and this fails.
const DOC = readFileSync(new URL("../docs/theme-packs.md", import.meta.url), "utf8");

/** Keys named in backticks in the table under `heading`, up to the next heading. */
function tableKeys(heading: string): string[] {
  const start = DOC.indexOf(heading);
  expect(start).not.toBe(-1);
  const rest = DOC.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  const section = end === -1 ? rest : rest.slice(0, end);
  const keys = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    for (const [, k] of line.matchAll(/`([a-z][a-z0-9.]*\.[a-z0-9.]+)`/g)) keys.add(k);
  }
  return [...keys].sort();
}

describe("theme pack guide", () => {
  it("documents exactly the sprite keys the code requires", () => {
    expect(tableKeys("## Required sprite keys")).toEqual([...REQUIRED_SPRITE_KEYS].sort());
  });

  it("documents exactly the string keys the code requires", () => {
    expect(tableKeys("## Required string keys")).toEqual([...REQUIRED_STRING_KEYS].sort());
  });

  it("ships an example manifest that actually validates", () => {
    const block = DOC.match(/```json\n([\s\S]*?)```/);
    expect(block).not.toBe(null);
    const manifest = JSON.parse(block![1]) as ThemeManifest;
    expect(validateTheme(manifest)).toEqual([]);
  });

  it("keeps the shipped default pack valid", () => {
    const pack = JSON.parse(
      readFileSync(new URL("../web/theme/theme.json", import.meta.url), "utf8")
    ) as ThemeManifest;
    expect(validateTheme(pack)).toEqual([]);
  });
});
