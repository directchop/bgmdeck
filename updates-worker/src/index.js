// BGM Deck update feed.
//
//   GET /{target}/{arch}/{bundle_type}/{current_version}[?channel=stable|beta]  (or header x-bgmdeck-channel)
//   GET /{target}/{arch}/{current_version}            (clients built before bundle_type was added)
//       Tauri updater dynamic endpoint. 200 + JSON when a newer build exists
//       for that platform, 204 when the client is current or nothing has been
//       published yet (the Tauri updater treats 404 as an error and shows
//       "Could not fetch a valid release JSON from the remote").
//   GET /dl/<key>      Streams an object from the R2 bucket (installers, .sig).
//   GET /manifest/<channel>.json   The raw Tauri latest.json for a channel.
//   GET /              Plain-text status.
//
// Layout in R2 (written by scripts/publish-updates.sh / release.yml):
//   releases/<version>/<asset files + .sig>
//   manifest/stable.json        copy of that version's latest.json
//   manifest/beta.json          optional pre-release channel
//
// URLs inside the manifest are rewritten to this worker's /dl/ path at
// serve time, so the bucket never needs to be public and the source repo can
// stay private.
import { compareVersions, parseVersion } from "./semver.js";

const CHANNELS = new Set(["stable", "beta"]);

/** The manifest a channel should serve. Beta clients get whichever of
 *  beta / stable is newer, so an empty or stale beta channel never hides a
 *  stable release from them. Exported for tests. */
export function pickManifest(channel, { stable, beta }) {
  if (channel !== "beta" || !beta?.version) return stable ?? null;
  if (!stable?.version) return beta;
  return (compareVersions(beta.version, stable.version) ?? -1) > 0 ? beta : stable;
}

/** Manifest keys to try, most specific first. Clients send their bundle type
 *  (`{{bundle_type}}` in the endpoint: nsis / msi / app / appimage / deb / rpm)
 *  so a setup.exe install gets the next setup.exe. Older Windows clients did
 *  not send it; all of those were installed from the NSIS setup.exe, so prefer
 *  it over the MSI for them. Serving the MSI to an NSIS install puts a second
 *  copy in Program Files and the one the user launches never updates.
 *  Exported for tests. */
export function platformKeys(target, arch, bundle) {
  const base = `${target}-${arch}`;
  if (bundle && bundle !== "unknown") return [`${base}-${bundle}`, base];
  if (target === "windows") return [`${base}-nsis`, base];
  return [base];
}

/** Build the response for one platform from a manifest. Exported for tests. */
export function updateFor(manifest, { target, arch, bundle, current, origin }) {
  const key = platformKeys(target, arch, bundle).find((k) => manifest?.platforms?.[k]);
  const platform = key ? manifest.platforms[key] : null;
  if (!platform || !manifest.version) return { status: 204 };
  const cmp = compareVersions(current, manifest.version);
  if (cmp === null) return { status: 400, error: `bad version "${current}"` };
  if (cmp >= 0) return { status: 204 };
  const file = platform.url.split("/").pop();
  return {
    status: 200,
    body: {
      version: manifest.version,
      notes: manifest.notes ?? "",
      pub_date: manifest.pub_date,
      url: `${origin}/dl/releases/${manifest.version}/${file}`,
      signature: platform.signature,
    },
  };
}

const CONTENT_TYPES = {
  json: "application/json",
  sig: "text/plain",
  dmg: "application/x-apple-diskimage",
  gz: "application/gzip",
  exe: "application/vnd.microsoft.portable-executable",
  msi: "application/x-msi",
  AppImage: "application/octet-stream",
  deb: "application/vnd.debian.binary-package",
  rpm: "application/x-rpm",
};

async function readManifest(env, channel) {
  const obj = await env.UPDATES.get(`manifest/${channel}.json`);
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 0) {
      return new Response("bgmdeck update feed\n", { headers: { "content-type": "text/plain" } });
    }

    if (parts[0] === "dl") {
      const key = decodeURIComponent(parts.slice(1).join("/"));
      if (!key.startsWith("releases/") || key.includes("..")) return new Response("not found", { status: 404 });
      const obj = await env.UPDATES.get(key);
      if (!obj) return new Response("not found", { status: 404 });
      const ext = key.split(".").pop();
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      // Explicit length so the updater can show download progress (and HEAD
      // answers with the size).
      headers.set("content-length", String(obj.size));
      headers.set("content-type", CONTENT_TYPES[ext] ?? "application/octet-stream");
      headers.set("cache-control", "public, max-age=31536000, immutable");
      return new Response(request.method === "HEAD" ? null : obj.body, { headers });
    }

    if (parts[0] === "manifest" && parts.length === 2) {
      const channel = parts[1].replace(/\.json$/, "");
      if (!CHANNELS.has(channel)) return new Response("not found", { status: 404 });
      const manifest = await readManifest(env, channel);
      if (!manifest) return new Response("not found", { status: 404 });
      return Response.json(manifest, { headers: { "cache-control": "no-store" } });
    }

    if (parts.length === 3 || parts.length === 4) {
      const p = parts.map(decodeURIComponent);
      const [target, arch] = p;
      const bundle = parts.length === 4 ? p[2] : undefined;
      const current = parts.length === 4 ? p[3] : p[2];
      if (!parseVersion(current)) return new Response("bad version", { status: 400 });
      // The app sends the channel as a header (Tauri's check({ headers })),
      // curl users can use ?channel=.
      const channel = request.headers.get("x-bgmdeck-channel") ?? url.searchParams.get("channel") ?? "stable";
      if (!CHANNELS.has(channel)) return new Response("unknown channel", { status: 404 });
      const [stable, beta] = await Promise.all([
        readManifest(env, "stable"),
        channel === "beta" ? readManifest(env, "beta") : null,
      ]);
      const manifest = pickManifest(channel, { stable, beta });
      // Nothing published yet: that is "no update", not an error.
      if (!manifest) return new Response(null, { status: 204 });
      const r = updateFor(manifest, { target, arch, bundle, current, origin: url.origin });
      if (r.status === 200) return Response.json(r.body, { headers: { "cache-control": "no-store" } });
      if (r.status === 400) return new Response(r.error, { status: 400 });
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  },
};
