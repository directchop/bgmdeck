import assert from "node:assert";
import test from "node:test";
import { loadDeck } from "./load-deck.mjs";

const el = (tagName, extra = {}) => ({ tagName, ...extra });

test("only text-entry controls count as typing; faders, checkboxes, buttons and selects do not", async () => {
  const { focusGuard } = await loadDeck();
  const { isTextEntry } = focusGuard;
  assert.equal(isTextEntry(null), false);
  assert.equal(isTextEntry(el("INPUT", { type: "text" })), true);
  assert.equal(isTextEntry(el("INPUT", { type: "" })), true);
  assert.equal(isTextEntry(el("INPUT", { type: "number" })), true);
  assert.equal(isTextEntry(el("TEXTAREA")), true);
  assert.equal(isTextEntry(el("DIV", { isContentEditable: true })), true);
  // Space must still stop the deck when one of these has focus.
  assert.equal(isTextEntry(el("INPUT", { type: "range" })), false);
  assert.equal(isTextEntry(el("INPUT", { type: "checkbox" })), false);
  assert.equal(isTextEntry(el("BUTTON")), false);
  assert.equal(isTextEntry(el("SELECT")), false);
  assert.equal(isTextEntry(el("DIV")), false);
});

test("focus guard blurs buttons and faders after a pointer click, not after a keyboard click", async () => {
  const listeners = {};
  const window = {
    addEventListener: (type, fn) => (listeners[type] = fn),
    removeEventListener: (type) => delete listeners[type],
  };
  const document = { activeElement: null };
  const { focusGuard } = await loadDeck({}, { window, document });
  const off = focusGuard.installFocusGuard();
  assert.equal(typeof listeners.click, "function");

  const blurred = [];
  const button = { blur: () => blurred.push("button"), closest: () => button };
  document.activeElement = button;
  listeners.click({ detail: 1, target: button });
  assert.deepEqual(blurred, ["button"]);

  // Keyboard-initiated click (Enter / Space on a focused button): keep focus.
  listeners.click({ detail: 0, target: button });
  assert.deepEqual(blurred, ["button"]);

  // A click inside a pad (plain div): nothing to blur.
  const div = { blur: () => blurred.push("div"), closest: () => null };
  document.activeElement = div;
  listeners.click({ detail: 1, target: div });
  assert.deepEqual(blurred, ["button"]);

  // Focus already moved elsewhere: do not blur the clicked control's stale handle.
  document.activeElement = div;
  listeners.click({ detail: 1, target: button });
  assert.deepEqual(blurred, ["button"]);

  off();
  assert.equal(listeners.click, undefined);
});
