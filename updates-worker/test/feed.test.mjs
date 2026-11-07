import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions } from "../src/semver.js";
import { pickManifest, updateFor } from "../src/index.js";

test("compareVersions orders releases and pre-releases", () => {
  assert.equal(compareVersions("0.6.0", "0.6.1"), -1);
  assert.equal(compareVersions("0.6.1", "0.6.1"), 0);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.7.0-beta.1", "0.7.0"), -1);
  assert.equal(compareVersions("0.7.0-beta.2", "0.7.0-beta.10"), -1);
  assert.equal(compareVersions("v0.6.0", "0.6.0"), 0);
  assert.equal(compareVersions("abc", "0.6.0"), null);
});

const manifest = {
  version: "0.6.1",
  notes: "fixes",
  pub_date: "2026-11-07T00:00:00Z",
  platforms: {
    "darwin-aarch64": { signature: "SIG-A", url: "https://github.com/x/y/releases/download/v0.6.1/BGM.Deck_aarch64.app.tar.gz" },
    "windows-x86_64": { signature: "SIG-W", url: "https://github.com/x/y/releases/download/v0.6.1/BGM.Deck_0.6.1_x64-setup.exe" },
  },
};
const origin = "https://updates.example";

test("older client gets the update with a /dl URL on this origin", () => {
  const r = updateFor(manifest, { target: "darwin", arch: "aarch64", current: "0.6.0", origin });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, "0.6.1");
  assert.equal(r.body.signature, "SIG-A");
  assert.equal(r.body.url, "https://updates.example/dl/releases/0.6.1/BGM.Deck_aarch64.app.tar.gz");
});

test("current or newer client gets 204; unknown platform gets 204; bad version 400", () => {
  assert.equal(updateFor(manifest, { target: "darwin", arch: "aarch64", current: "0.6.1", origin }).status, 204);
  assert.equal(updateFor(manifest, { target: "darwin", arch: "aarch64", current: "0.7.0", origin }).status, 204);
  assert.equal(updateFor(manifest, { target: "linux", arch: "x86_64", current: "0.6.0", origin }).status, 204);
  assert.equal(updateFor(manifest, { target: "windows", arch: "x86_64", current: "nope", origin }).status, 400);
  assert.equal(updateFor(null, { target: "windows", arch: "x86_64", current: "0.6.0", origin }).status, 204);
});

test("beta channel serves the newer of beta/stable, stable ignores beta", () => {
  const stable = { version: "0.6.1", platforms: {} };
  const beta = { version: "0.7.0-beta.1", platforms: {} };
  const oldBeta = { version: "0.6.0-beta.3", platforms: {} };
  assert.equal(pickManifest("beta", { stable, beta }), beta);
  assert.equal(pickManifest("beta", { stable, beta: oldBeta }), stable);
  assert.equal(pickManifest("beta", { stable, beta: null }), stable);
  assert.equal(pickManifest("beta", { stable: null, beta }), beta);
  assert.equal(pickManifest("stable", { stable, beta }), stable);
  assert.equal(pickManifest("stable", { stable: null, beta }), null);
});
