import assert from "node:assert";
import test from "node:test";
import { loadDeck } from "./load-deck.mjs";

test("updates only while idle; prefs persist", async () => {
  const { updatePolicy, localStorage } = await loadDeck();
  assert.equal(updatePolicy.updatesAllowedNow(false), true);
  assert.equal(updatePolicy.updatesAllowedNow(true), false);
  assert.equal(updatePolicy.shouldCheckOnStartup({ checkOnStartup: true, channel: "stable" }, true), false);
  assert.equal(updatePolicy.shouldCheckOnStartup({ checkOnStartup: false, channel: "stable" }, false), false);
  assert.equal(updatePolicy.shouldCheckOnStartup({ checkOnStartup: true, channel: "stable" }, false), true);
  updatePolicy.saveUpdatePrefs({ checkOnStartup: false, channel: "beta" });
  assert.ok(localStorage.getItem(updatePolicy.UPDATE_PREFS_KEY));
  assert.deepEqual(updatePolicy.loadUpdatePrefs(), { checkOnStartup: false, channel: "beta" });
  localStorage.setItem(updatePolicy.UPDATE_PREFS_KEY, "{}");
  assert.deepEqual(updatePolicy.loadUpdatePrefs(), { checkOnStartup: true, channel: "stable" });
});
