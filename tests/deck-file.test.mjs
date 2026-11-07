import assert from "node:assert";
import test from "node:test";
import { loadDeck } from "./load-deck.mjs";

test("new deck has one bank of ten empty pads and default settings", async () => {
  const { deckFile, types } = await loadDeck();
  const d = deckFile.newDeckData();
  assert.equal(d.banks.length, 1);
  assert.equal(d.banks[0].slots.length, types.SLOTS_PER_BANK);
  assert.ok(d.banks[0].slots.every((s) => s.path === null && s.loop === true && s.volume === 1));
  assert.deepEqual(d.settings, types.DEFAULT_SETTINGS);
});

test("serialize → parse round-trips and tolerates missing / bad fields", async () => {
  const { deckFile } = await loadDeck();
  const d = deckFile.newDeckData();
  d.name = "Gala";
  d.banks[0].slots[2] = { ...d.banks[0].slots[2], path: "/music/open.wav", name: "Opening", duration: 123.4, peaks: [0.1, 0.9], volume: 0.5, loop: false, color: "teal" };
  d.settings.crossfadeSec = 4.5;
  const text = deckFile.serializeDeck(d);
  const doc = JSON.parse(text);
  assert.equal(doc.format, "bgmdeck");
  assert.equal(doc.version, 1);
  const back = deckFile.parseDeck(text);
  assert.equal(back.name, "Gala");
  assert.equal(back.banks[0].slots[2].path, "/music/open.wav");
  assert.equal(back.banks[0].slots[2].color, "teal");
  assert.equal(back.banks[0].slots[2].volume, 0.5);
  assert.equal(back.settings.crossfadeSec, 4.5);
  assert.equal(back.banks[0].slots[2].id, d.banks[0].slots[2].id);

  // Garbage in individual fields falls back to defaults, short banks are padded.
  const loose = deckFile.parseDeck(JSON.stringify({
    banks: [{ slots: [{ path: "/a.mp3", volume: 7, color: "neon", loop: "yes", peaks: "x" }] }],
    settings: { crossfadeSec: -1, fadeCurve: "weird", duckLevel: 2 },
  }));
  assert.equal(loose.banks[0].slots.length, 10);
  assert.equal(loose.banks[0].slots[0].volume, 1);
  assert.equal(loose.banks[0].slots[0].color, null);
  assert.equal(loose.banks[0].slots[0].loop, true);
  assert.equal(loose.banks[0].slots[0].peaks, null);
  assert.equal(loose.banks[0].name, "Bank 1");
  assert.equal(loose.settings.crossfadeSec, 3);
  assert.equal(loose.settings.fadeCurve, "equal-power");
  assert.equal(loose.settings.duckLevel, 1);
});

test("parse rejects non-deck files and newer formats, dedupes slot ids", async () => {
  const { deckFile } = await loadDeck();
  assert.throws(() => deckFile.parseDeck("not json"), /invalid JSON/);
  assert.throws(() => deckFile.parseDeck(JSON.stringify({ format: "playque" })), /format "playque"/);
  assert.throws(() => deckFile.parseDeck(JSON.stringify({ format: "bgmdeck", version: 99 })), /newer BGM Deck/);
  const dup = deckFile.parseDeck(JSON.stringify({ banks: [{ slots: [{ id: "x" }, { id: "x" }] }] }));
  assert.notEqual(dup.banks[0].slots[0].id, dup.banks[0].slots[1].id);
});

test("slot labels fall back to the file name without extension", async () => {
  const { deckFile } = await loadDeck();
  assert.equal(deckFile.slotLabel({ name: "", path: "/x/Walk In.mp3" }), "Walk In");
  assert.equal(deckFile.slotLabel({ name: "Opener", path: "/x/Walk In.mp3" }), "Opener");
  assert.equal(deckFile.slotLabel({ name: "", path: null }), "");
  assert.equal(deckFile.deckNameFromPath("C:\\shows\\Gala.bgmdeck"), "Gala");
});
