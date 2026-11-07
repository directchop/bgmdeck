// OSC address space. Pads and banks are 1-based on the wire (what people
// type into TouchOSC / playque), 0-based internally.
//
//   /bgmdeck/play <i pad> [f fade]        play pad N of the current bank
//   /bgmdeck/play/<pad>  [f fade]
//   /bgmdeck/bank/<bank>/play/<pad>       play pad N of bank B (switches bank)
//   /bgmdeck/stop [f fade]                stop with fade (deck default)
//   /bgmdeck/stop/now                     stop immediately
//   /bgmdeck/bank <i bank> | /bgmdeck/bank/<bank> | /bgmdeck/bank/next | /prev
//   /bgmdeck/master <f 0..1>
//   /bgmdeck/pad/<pad>/volume <f 0..1>
//   /bgmdeck/duck <i 0|1> | /bgmdeck/duck/on | /off | /toggle
//   /bgmdeck/ping                          → replies /bgmdeck/pong to the sender
import { onOscReceived, oscSend, type OscArg, type OscReceived } from "./bridge";
import { usePrefsStore } from "./prefsStore";
import { executeRemote, type RemoteCommand } from "./remoteCommands";

export const OSC_REFERENCE: [string, string][] = [
  ["/bgmdeck/play <pad>  [fade]", "Play pad 1–10 of the current bank"],
  ["/bgmdeck/play/<pad>  [fade]", "Same, pad in the address"],
  ["/bgmdeck/bank/<bank>/play/<pad>", "Play a pad in another bank (switches to it)"],
  ["/bgmdeck/stop  [fade]", "Fade out (deck's Stop fade unless given)"],
  ["/bgmdeck/stop/now", "Stop immediately"],
  ["/bgmdeck/bank <bank>  |  /bgmdeck/bank/<bank>", "Switch bank"],
  ["/bgmdeck/bank/next  |  /bgmdeck/bank/prev", "Step through banks"],
  ["/bgmdeck/master <0..1>", "Master volume"],
  ["/bgmdeck/pad/<pad>/volume <0..1>", "Pad volume (current bank)"],
  ["/bgmdeck/duck <0|1>  |  /duck/on  /off  /toggle", "Duck under an announcement"],
  ["/bgmdeck/ping", "Replies /bgmdeck/pong to the sender"],
];

function num(args: OscArg[], i: number): number | undefined {
  const a = args[i];
  if (!a) return undefined;
  if (a.type === "int" || a.type === "float") {
    const v = Number(a.value);
    return Number.isFinite(v) ? v : undefined;
  }
  if (a.type === "string") {
    const v = Number(a.value);
    return Number.isFinite(v) ? v : undefined;
  }
  if (a.type === "bool") return a.value === "true" ? 1 : 0;
  return undefined;
}

const pad = (v: number | undefined) => (v !== undefined && Number.isInteger(v) && v >= 1 && v <= 10 ? v - 1 : undefined);
const bank = (v: number | undefined) => (v !== undefined && Number.isInteger(v) && v >= 1 ? v - 1 : undefined);
const unit = (v: number | undefined) => (v === undefined ? undefined : Math.min(1, Math.max(0, v)));

/** Map one OSC message to a command, or null when it isn't ours. */
export function oscToCommand(address: string, args: OscArg[]): RemoteCommand | null {
  const parts = address.split("/").filter(Boolean);
  if (parts[0] !== "bgmdeck") return null;
  const p = parts.slice(1);
  if (p.length === 0) return null;

  switch (p[0]) {
    case "play": {
      const n = p.length >= 2 ? pad(Number(p[1])) : pad(num(args, 0));
      if (n === undefined) return null;
      const fade = p.length >= 2 ? num(args, 0) : num(args, 1);
      return { type: "play", pad: n, fade: fade !== undefined && fade >= 0 ? fade : undefined };
    }
    case "stop":
      if (p[1] === "now") return { type: "stopNow" };
      if (p.length === 1) {
        const fade = num(args, 0);
        return { type: "stop", fade: fade !== undefined && fade >= 0 ? fade : undefined };
      }
      return null;
    case "bank": {
      if (p[1] === "next") return { type: "bankNext" };
      if (p[1] === "prev") return { type: "bankPrev" };
      if (p.length === 1) {
        const b = bank(num(args, 0));
        return b === undefined ? null : { type: "bank", index: b };
      }
      const b = bank(Number(p[1]));
      if (b === undefined) return null;
      if (p.length === 2) return { type: "bank", index: b };
      if (p[2] === "play") {
        const n = p.length >= 4 ? pad(Number(p[3])) : pad(num(args, 0));
        if (n === undefined) return null;
        return { type: "play", pad: n, bank: b };
      }
      return null;
    }
    case "master": {
      const v = unit(num(args, 0));
      return v === undefined ? null : { type: "master", value: v };
    }
    case "pad": {
      const n = pad(Number(p[1]));
      if (n === undefined || p[2] !== "volume") return null;
      const v = unit(num(args, 0));
      return v === undefined ? null : { type: "padVolume", pad: n, value: v };
    }
    case "duck": {
      if (p[1] === "on") return { type: "duck", on: true };
      if (p[1] === "off") return { type: "duck", on: false };
      if (p[1] === "toggle") return { type: "duck", on: "toggle" };
      if (p.length === 1) {
        const v = num(args, 0);
        if (v === undefined) return { type: "duck", on: "toggle" };
        return { type: "duck", on: v !== 0 };
      }
      return null;
    }
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
}

export interface OscLogEntry {
  at: number;
  address: string;
  args: string;
  from: string;
  handled: boolean;
}

const log: OscLogEntry[] = [];
const logListeners = new Set<() => void>();
export const OSC_LOG_MAX = 50;

export function oscLog(): OscLogEntry[] {
  return log;
}

export function subscribeOscLog(fn: () => void): () => void {
  logListeners.add(fn);
  return () => {
    logListeners.delete(fn);
  };
}

export function handleOsc(m: OscReceived): void {
  const cmd = oscToCommand(m.address, m.args);
  log.unshift({ at: Date.now(), address: m.address, args: m.args.map((a) => a.value).join(" "), from: m.from, handled: !!cmd });
  if (log.length > OSC_LOG_MAX) log.length = OSC_LOG_MAX;
  logListeners.forEach((fn) => fn());
  if (!cmd) return;
  if (cmd.type === "ping") {
    void oscSend(m.from, "/bgmdeck/pong", []).catch(() => {});
    return;
  }
  executeRemote(cmd);
}

/** Subscribe to incoming OSC. Returns a cleanup. */
export function installOscReceive(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  onOscReceived(handleOsc).then((off) => {
    if (disposed) off();
    else unlisten = off;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** Apply the OSC listener prefs to the engine (and on every change). */
export function installOscListener(configure: (port: number | null, iface: string) => Promise<void>): () => void {
  const apply = async () => {
    const { remote, setOscError } = usePrefsStore.getState();
    try {
      await configure(remote.oscEnabled ? remote.oscPort : null, remote.oscInterface);
      setOscError(null);
    } catch (e) {
      setOscError(e instanceof Error ? e.message : String(e));
    }
  };
  void apply();
  // Interfaces come and go (Wi-Fi joins after launch): retry while in error.
  const retry = setInterval(() => {
    const { remote, oscError } = usePrefsStore.getState();
    if (remote.oscEnabled && oscError) void apply();
  }, 5000);
  const off = usePrefsStore.subscribe((s, p) => {
    if (s.remote.oscEnabled !== p.remote.oscEnabled || s.remote.oscPort !== p.remote.oscPort || s.remote.oscInterface !== p.remote.oscInterface) {
      void apply();
    }
  });
  return () => {
    clearInterval(retry);
    off();
  };
}
