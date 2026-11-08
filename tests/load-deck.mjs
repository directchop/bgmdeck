import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { create } from "zustand";

const ROOT = new URL("../", import.meta.url);

const MODULES = [
  "src/store/types.ts",
  "src/focusGuard.ts",
  "src/store/deck.ts",
  "src/deckFile.ts",
  "src/session.ts",
  "src/prefs.ts",
  "src/prefsStore.ts",
  "src/remoteCommands.ts",
  "src/oscReceive.ts",
  "src/oscFeedback.ts",
  "src/midiMap.ts",
  "src/dropFiles.ts",
  "src/commandDedupe.ts",
  "src/format.ts",
  "src/updatePolicy.ts",
  "src/engineSync.ts",
  "src/deckIO.ts",
];

class MemoryStorage {
  #m = new Map();
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
  clear() { this.#m.clear(); }
  get length() { return this.#m.size; }
}

/** Load the real TypeScript modules into a fresh vm context, replacing only
 *  the native IPC boundary (`bridge.ts`). `overrides[name]` fakes a bridge
 *  call; every call is recorded in `calls`. */
export async function loadDeck(overrides = {}, globals = {}) {
  const calls = [];
  const errors = [];
  const localStorage = new MemoryStorage();
  const context = vm.createContext({
    performance,
    localStorage,
    __APP_VERSION__: "test",
    setTimeout,
    clearTimeout,
    // Retry intervals from the glue modules must not keep the test process alive.
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
    clearInterval,
    Date,
    Math,
    console: { ...console, error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
    ...globals,
  });
  const bridgeSource = readFileSync(new URL("src/bridge.ts", ROOT), "utf8");
  const bridgeNames = [...bridgeSource.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]);
  const bridge = new vm.SyntheticModule(
    bridgeNames,
    function () {
      for (const name of bridgeNames) {
        this.setExport(name, (...args) => {
          calls.push({ name, args });
          if (overrides[name]) return overrides[name](...args);
          if (name === "hasNativeDialogs") return true;
          if (name.startsWith("on")) return Promise.resolve(() => {});
          if (name === "audioDeviceLabel") return String(args[0] ?? "");
          return Promise.resolve(undefined);
        });
      }
    },
    { context },
  );
  const zustand = new vm.SyntheticModule(["create"], function () { this.setExport("create", create); }, { context });
  const modules = new Map();
  for (const p of MODULES) {
    const source = readFileSync(new URL(p, ROOT), "utf8").replace(/\r\n/g, "\n");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.ESNext } });
    modules.set(p, new vm.SourceTextModule(outputText, { context, identifier: p }));
  }
  const link = (specifier, referencing) => {
    if (specifier === "zustand") return zustand;
    if (/(^|\/)bridge$/.test(specifier)) return bridge;
    const base = path.posix.dirname(referencing.identifier);
    let resolved = path.posix.normalize(path.posix.join(base, specifier));
    if (!resolved.endsWith(".ts")) resolved += ".ts";
    const m = modules.get(resolved);
    if (!m) throw new Error(`Unexpected test import: ${specifier} from ${referencing.identifier}`);
    return m;
  };
  // link() walks the whole graph; linking a root twice throws, so link only
  // modules nothing has reached yet, then evaluate every root.
  for (const m of modules.values()) if (m.status === "unlinked") await m.link(link);
  for (const m of modules.values()) if (m.status === "linked") await m.evaluate();
  const ns = (p) => modules.get(p).namespace;
  return {
    calls,
    errors,
    localStorage,
    store: ns("src/store/deck.ts").useDeckStore,
    deck: ns("src/store/deck.ts"),
    types: ns("src/store/types.ts"),
    deckFile: ns("src/deckFile.ts"),
    session: ns("src/session.ts"),
    prefs: ns("src/prefs.ts"),
    prefsStore: ns("src/prefsStore.ts").usePrefsStore,
    remote: ns("src/remoteCommands.ts"),
    osc: ns("src/oscReceive.ts"),
    oscFeedback: ns("src/oscFeedback.ts"),
    midi: ns("src/midiMap.ts"),
    drop: ns("src/dropFiles.ts"),
    format: ns("src/format.ts"),
    commandDedupe: ns("src/commandDedupe.ts"),
    updatePolicy: ns("src/updatePolicy.ts"),
    engineSync: ns("src/engineSync.ts"),
    deckIO: ns("src/deckIO.ts"),
    focusGuard: ns("src/focusGuard.ts"),
  };
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
