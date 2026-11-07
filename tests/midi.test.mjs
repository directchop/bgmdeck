import assert from "node:assert";
import test from "node:test";
import { loadDeck } from "./load-deck.mjs";

test("note on → command with channel filter; learn rebinds and dedupes", async () => {
  const { midi, prefs } = await loadDeck();
  const map = prefs.DEFAULT_MIDI_MAP;
  assert.deepEqual(midi.parseNoteOn([0x91, 36, 100]), { channel: 2, note: 36, velocity: 100 });
  assert.equal(midi.parseNoteOn([0x90, 36, 0]), null, "velocity 0 is note off");
  assert.equal(midi.parseNoteOn([0xb0, 1, 64]), null);
  assert.deepEqual(midi.midiToCommand([0x90, 36, 100], map), { type: "play", pad: 0 });
  assert.deepEqual(midi.midiToCommand([0x90, 45, 100], map), { type: "play", pad: 9 });
  assert.deepEqual(midi.midiToCommand([0x90, 46, 1], map), { type: "stop" });
  assert.deepEqual(midi.midiToCommand([0x90, 48, 1], map), { type: "duck", on: "toggle" });
  assert.equal(midi.midiToCommand([0x90, 100, 1], map), null);
  assert.equal(midi.midiToCommand([0x91, 36, 100], { ...map, channel: 1 }), null, "wrong channel");
  assert.deepEqual(midi.midiToCommand([0x91, 36, 100], { ...map, channel: 2 }), { type: "play", pad: 0 });

  const learned = midi.assignNote(map, { kind: "pad", index: 2 }, 46);
  assert.equal(learned.padNotes[2], 46);
  assert.equal(learned.stopNote, -1, "note taken away from its old binding");
  const stop = midi.assignNote(learned, { kind: "stop" }, 36);
  assert.equal(stop.stopNote, 36);
  assert.equal(stop.padNotes[0], -1);
  assert.equal(midi.noteName(36), "C2");
  assert.equal(midi.noteName(-1), "—");
});

test("handleMidi: learn captures the next note, then plays pads", async () => {
  const { midi, prefsStore, store, calls } = await loadDeck({ deckPlay: async () => 1 });
  const id = store.getState().banks[0].slots[4].id;
  store.getState().assignFile(id, "/m/e.wav");
  midi.midiLearn.start({ kind: "pad", index: 4 });
  midi.handleMidi([0x90, 60, 90]);
  assert.equal(prefsStore.getState().remote.midi.padNotes[4], 60);
  assert.equal(midi.midiLearn.target(), null);
  assert.equal(calls.filter((c) => c.name === "deckPlay").length, 0, "learning note does not trigger");
  midi.handleMidi([0x90, 60, 90]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.filter((c) => c.name === "deckPlay").pop().args[0], id);
  assert.deepEqual(midi.midiLearn.lastNote(), { channel: 1, note: 60, velocity: 90 });
});
