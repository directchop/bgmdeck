import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions } from "../src/semver.js";
import { pickManifest, updateFor, platformKeys } from "../src/index.js";

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

test("bundle type picks the matching installer; old Windows clients default to NSIS", () => {
  const manifest = {
    version: "0.6.4",
    pub_date: "2026-11-08T00:00:00Z",
    platforms: {
      "windows-x86_64": { url: "https://x/playque_0.6.4_x64_en-US.msi", signature: "s-msi" },
      "windows-x86_64-msi": { url: "https://x/playque_0.6.4_x64_en-US.msi", signature: "s-msi" },
      "windows-x86_64-nsis": { url: "https://x/playque_0.6.4_x64-setup.exe", signature: "s-nsis" },
      "darwin-aarch64": { url: "https://x/playque_aarch64.app.tar.gz", signature: "s-app" },
    },
  };
  const origin = "https://feed.test";
  const file = (r) => r.body.url.split("/").pop();
  assert.deepEqual(platformKeys("windows", "x86_64", "nsis"), ["windows-x86_64-nsis", "windows-x86_64"]);
  assert.deepEqual(platformKeys("windows", "x86_64", undefined), ["windows-x86_64-nsis", "windows-x86_64"]);
  assert.deepEqual(platformKeys("windows", "x86_64", "unknown"), ["windows-x86_64-nsis", "windows-x86_64"]);
  assert.deepEqual(platformKeys("darwin", "aarch64", undefined), ["darwin-aarch64"]);
  assert.equal(file(updateFor(manifest, { target: "windows", arch: "x86_64", bundle: "nsis", current: "0.6.3", origin })), "playque_0.6.4_x64-setup.exe");
  assert.equal(file(updateFor(manifest, { target: "windows", arch: "x86_64", bundle: "msi", current: "0.6.3", origin })), "playque_0.6.4_x64_en-US.msi");
  assert.equal(file(updateFor(manifest, { target: "windows", arch: "x86_64", current: "0.6.3", origin })), "playque_0.6.4_x64-setup.exe");
  assert.equal(updateFor(manifest, { target: "windows", arch: "x86_64", bundle: "nsis", current: "0.6.3", origin }).body.signature, "s-nsis");
  // A bundle the manifest lacks falls back to the plain key.
  assert.equal(file(updateFor(manifest, { target: "darwin", arch: "aarch64", bundle: "app", current: "0.6.3", origin })), "playque_aarch64.app.tar.gz");
  assert.equal(updateFor(manifest, { target: "windows", arch: "x86_64", bundle: "nsis", current: "0.6.4", origin }).status, 204);
});
