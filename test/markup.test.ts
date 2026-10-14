import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { expect } from "./expect.ts";

// The page's stylesheet is checked here because one line of it silently
// disabled every hidden row: a class that sets `display` outranks the
// browser's own `[hidden] { display: none }`, so "Copy invite" and "Leave"
// were on screen with no room joined. There is no DOM in this suite, so the
// rule is asserted as text — crude, but it catches the thing that broke.
const HTML = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

describe("page markup", () => {
  it("makes the hidden attribute win over any display rule", () => {
    expect(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(HTML)).toBe(true);
  });

  it("every element the code hides is addressable by id", () => {
    // Each of these is toggled by main.ts; a rename that misses one would
    // leave a control permanently stuck in whichever state it was in.
    for (const id of [
      "you-row", "online-room", "online-actions", "rescue",
      "notice", "share-url", "confirm", "help",
      "pane-now", "pane-rules", "pane-tutorial",
    ]) {
      expect(HTML.includes(`id="${id}"`)).toBe(true);
    }
  });

  it("explains the two different links rather than labelling both 'copy'", () => {
    expect(HTML.includes("Copy game link")).toBe(true);
    expect(HTML.includes("Copy invite")).toBe(true);
    // Each carries a tooltip saying which is which.
    expect(/id="share"[^>]*title="[^"]+/.test(HTML)).toBe(true);
    expect(/id="copy-room"[^>]*title="[^"]+/.test(HTML)).toBe(true);
  });

  it("does not leave a disabled control looking pressable", () => {
    expect(/button:disabled[^{]*\{[^}]*cursor:\s*not-allowed/.test(HTML)).toBe(true);
  });
});
