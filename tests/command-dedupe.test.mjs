import test from "node:test";
import assert from "node:assert";
import { loadDeck } from "./load-deck.mjs";

async function deduper(windowMs = 400) {
  const { commandDedupe } = await loadDeck();
  let t = 0;
  const d = new commandDedupe.CommandDeduper(windowMs, () => t);
  return { d, tick: (ms) => (t += ms) };
}

test("a key arrival and its menu echo run once, in either order", async () => {
  const { d, tick } = await deduper();
  assert.equal(d.accept("edit.undo", "key"), true);
  tick(5);
  assert.equal(d.accept("edit.undo", "menu"), false);
  tick(50);
  assert.equal(d.accept("edit.undo", "menu"), true);
  tick(5);
  assert.equal(d.accept("edit.undo", "key"), false);
});

test("same-source repeats are never paired (held key repeats undo)", async () => {
  const { d, tick } = await deduper();
  for (let i = 0; i < 5; i++) {
    assert.equal(d.accept("edit.undo", "key"), true, `repeat ${i}`);
    tick(5);
    assert.equal(d.accept("edit.undo", "menu"), false, `echo ${i}`);
    tick(28);
  }
});

test("an echo outside the window is a new command; ids are independent", async () => {
  const { d, tick } = await deduper(400);
  assert.equal(d.accept("file.save", "key"), true);
  tick(401);
  assert.equal(d.accept("file.save", "menu"), true);
  assert.equal(d.accept("file.open", "menu"), true);
  assert.equal(d.accept("file.save", "key"), false);
});

test("a platform where only one source fires never loses commands", async () => {
  const { d, tick } = await deduper();
  for (let i = 0; i < 3; i++) {
    assert.equal(d.accept("view.zoomIn", "menu"), true);
    tick(100);
  }
});
