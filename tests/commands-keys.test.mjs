import assert from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";

// `commands.ts` imports React-side modules; extract the pure key mapper.
function loadCommandForKey(isMac) {
  const src = readFileSync(new URL("../src/commands.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("export function commandForKey(");
  const end = src.indexOf("\n}\n", start) + 3;
  const body = src
    .slice(start, end)
    .replace("export function commandForKey(", "function commandForKey(")
    .replace(/\(\s*e: Pick<[\s\S]*?>,\s*typing: boolean,?\s*\): string \| null/, "(e, typing)");
  return new Function("isMac", `${body}; return commandForKey;`)(isMac);
}

const key = (code, extra = {}) => ({ code, key: code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });

test("bare keys drive the deck and are ignored while typing", () => {
  const map = loadCommandForKey(true);
  assert.equal(map(key("Digit1"), false), "deck.play.1");
  assert.equal(map(key("Numpad9"), false), "deck.play.9");
  assert.equal(map(key("Digit0"), false), "deck.play.10");
  assert.equal(map(key("Space"), false), "deck.stop");
  assert.equal(map(key("Space", { shiftKey: true }), false), "deck.stopNow");
  assert.equal(map(key("KeyD"), false), "deck.duck");
  assert.equal(map(key("BracketLeft"), false), "bank.prev");
  assert.equal(map(key("BracketRight"), false), "bank.next");
  assert.equal(map(key("Tab"), false), "view.toggleSettings");
  assert.equal(map(key("Tab", { shiftKey: true }), false), null);
  assert.equal(map(key("Enter"), false), "pad.rename");
  assert.equal(map(key("Backspace"), false), "pad.clear");
  assert.equal(map(key("Slash", { shiftKey: true }), false), "help.shortcuts");
  assert.equal(map(key("Digit1"), true), null);
  assert.equal(map(key("Space"), true), null);
  assert.equal(map(key("Digit1", { altKey: true }), false), null);
});

test("modifier shortcuts follow the platform and stay live in text fields", () => {
  const mac = loadCommandForKey(true);
  assert.equal(mac(key("KeyS", { metaKey: true }), true), "file.save");
  assert.equal(mac(key("KeyS", { metaKey: true, shiftKey: true }), false), "file.saveAs");
  assert.equal(mac(key("KeyS", { ctrlKey: true }), false), null);
  assert.equal(mac(key("KeyN", { metaKey: true, shiftKey: true }), false), "bank.add");
  assert.equal(mac(key("KeyZ", { metaKey: true }), false), "edit.undo");
  assert.equal(mac(key("KeyZ", { metaKey: true }), true), null, "native undo in fields");
  assert.equal(mac(key("Comma", { metaKey: true }), true), "app.settings");
  const win = loadCommandForKey(false);
  assert.equal(win(key("KeyS", { ctrlKey: true }), false), "file.save");
  assert.equal(win(key("KeyY", { ctrlKey: true }), false), "edit.redo");
  assert.equal(win(key("Digit2", { ctrlKey: true }), false), "view.settings");
});

test("Space stops whatever has focus except a text field, and never maps to play", () => {
  const map = loadCommandForKey(true);
  // `typing` is only true for text-entry controls (see focus-guard.test.mjs).
  assert.equal(map(key("Space"), false), "deck.stop");
  assert.equal(map(key("Space", { shiftKey: true }), false), "deck.stopNow");
  assert.equal(map(key("Space"), true), null);
  for (const typing of [false, true]) {
    for (const extra of [{}, { shiftKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true }]) {
      const id = map(key("Space", extra), typing);
      assert.ok(id === null || id.startsWith("deck.stop"), `Space ${JSON.stringify(extra)} -> ${id}`);
    }
  }
});
