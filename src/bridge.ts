// Bridge between the React frontend and the Tauri backend. Falls back to a
// silent mock in the browser (`npm run dev` without Tauri) so the UI can be
// developed and the logic unit-tested.
import type { DeckStatus } from "./store/types";

const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

export function hasNativeDialogs(): boolean {
  return isTauri;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) return mockInvoke(cmd, args);
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke(cmd, args);
}

async function listen(event: string, callback: (payload: any) => void): Promise<() => void> {
  if (!isTauri) {
    const set = mockListeners.get(event) ?? new Set();
    set.add(callback);
    mockListeners.set(event, set);
    return () => {
      set.delete(callback);
    };
  }
  const { listen: tauriListen } = await import("@tauri-apps/api/event");
  return tauriListen(event, (e) => callback(e.payload));
}

// ---- audio device ----

export interface AudioDeviceInfo {
  id: string;
  name: string;
  host: string;
  maxChannels: number;
  defaultSampleRate: number;
  isDefault: boolean;
}

export interface AppliedAudio {
  deviceId: string;
  sampleRate: number;
  channels: number;
}

export const audioListDevices = () => invoke<AudioDeviceInfo[]>("audio_list_devices");

export const audioRestart = (deviceId: string | null, sampleRate: number | null, bufferSize: number | null) =>
  invoke<AppliedAudio>("audio_restart", { deviceId, sampleRate, bufferSize });

export const audioGetChannels = () => invoke<number>("audio_get_channels");

/** "CoreAudio::MacBook Pro Speakers" → "MacBook Pro Speakers". */
export function audioDeviceLabel(id: string | null | undefined): string {
  if (!id) return "Default output";
  const i = id.indexOf("::");
  return i >= 0 ? id.slice(i + 2) : id;
}

// ---- pads / deck ----

export interface FileInfo {
  duration: number;
  sampleRate: number;
  channels: number;
  peaks: number[];
}

export const slotLoad = (slotId: string, path: string, looping: boolean) =>
  invoke<FileInfo>("slot_load", { slotId, path, looping });
export const slotUnload = (slotId: string) => invoke<void>("slot_unload", { slotId });
export const slotSetLooping = (slotId: string, looping: boolean) => invoke<void>("slot_set_looping", { slotId, looping });
export const slotSetVolume = (slotId: string, volume: number) => invoke<void>("slot_set_volume", { slotId, volume });

export const deckPlay = (slotId: string, volume: number, fadeIn: number, fadeOut: number) =>
  invoke<number>("deck_play", { slotId, volume, fadeIn, fadeOut });
export const deckStop = (fade: number) => invoke<void>("deck_stop", { fade });
export const deckStopSlot = (slotId: string, fade: number) => invoke<void>("deck_stop_slot", { slotId, fade });
export const deckSetMaster = (volume: number) => invoke<void>("deck_set_master", { volume });
export const deckSetDuck = (on: boolean, level: number, fade: number) => invoke<void>("deck_set_duck", { on, level, fade });
export const deckSetRouting = (left: number, right: number) => invoke<void>("deck_set_routing", { left, right });
export const deckSetCurve = (curve: string) => invoke<void>("deck_set_curve", { curve });

export const onDeckStatus = (cb: (s: DeckStatus) => void) => listen("deck-status", cb);
export const onAudioStreamError = (cb: (p: { message: string }) => void) => listen("audio-stream-error", cb);

// ---- OSC / MIDI ----

export interface NetInterface {
  name: string;
  address: string;
}

export interface OscArg {
  type: "int" | "float" | "string" | "bool" | "other";
  value: string;
}

export interface OscReceived {
  address: string;
  args: OscArg[];
  from: string;
}

export const oscConfigure = (port: number | null, iface: string) => invoke<void>("osc_configure", { port, interface: iface });
export const oscListInterfaces = () => invoke<NetInterface[]>("osc_list_interfaces");
export const oscSend = (target: string, address: string, args: OscArg[]) => invoke<void>("osc_send", { target, address, args });
export const onOscReceived = (cb: (m: OscReceived) => void) => listen("osc-received", cb);

export const midiListInputs = () => invoke<string[]>("midi_list_inputs");
export const midiConnect = (name: string | null) => invoke<void>("midi_connect", { name });
export const onMidiMessage = (cb: (m: { data: number[] }) => void) => listen("midi-message", cb);

// ---- files / dialogs ----

export const deckPickSavePath = (defaultName: string) => invoke<string | null>("deck_pick_save_path", { defaultName });
export const deckPickOpenPath = () => invoke<string | null>("deck_pick_open_path");
export const filePickAudio = () => invoke<string | null>("file_pick_audio");
export const deckWrite = (path: string, contents: string) => invoke<void>("deck_write", { path, contents });
export const deckRead = (path: string) => invoke<string>("deck_read", { path });
export const fileExists = (path: string) => invoke<boolean>("file_exists", { path });
export const dialogConfirm = (title: string, message: string) => invoke<boolean>("dialog_confirm", { title, message });
export const dialogMessage = (title: string, message: string, error = false) =>
  invoke<void>("dialog_message", { title, message, error });

// ---- window / menu / logging ----

export interface MenuState {
  playing: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasDeckPath: boolean;
  padSelected: boolean;
  duckOn: boolean;
  showWaveforms: boolean;
  tab: string;
}

export const menuSync = (state: MenuState) => invoke<void>("menu_sync", { state });
export const onMenuCommand = (cb: (id: string) => void) => listen("menu-command", cb);
export const openPath = (path: string) => invoke<void>("open_path", { path });
export const openUrl = (url: string) => invoke<void>("open_url", { url });
export const windowSetTitle = (title: string) => invoke<void>("window_set_title", { title });
export const deckSetDirty = (dirty: boolean) => invoke<void>("deck_set_dirty", { dirty });
export const logFrontend = (level: "info" | "warn" | "error", message: string) =>
  invoke<void>("log_frontend", { level, message });
export const appLogDir = () => invoke<string | null>("app_log_dir");

// ---- browser mock ----

const mockListeners = new Map<string, Set<(payload: any) => void>>();
const mockSlots = new Map<string, { path: string; duration: number }>();
let mockVoices: { gen: number; slotId: string; startedAt: number; duration: number | null; stage: "fadeIn" | "steady" | "fadeOut"; stoppedAt?: number }[] = [];
let mockGen = 1;
let mockTimer: ReturnType<typeof setInterval> | null = null;

function mockEmit(event: string, payload: any) {
  mockListeners.get(event)?.forEach((cb) => cb(payload));
}

function mockTick() {
  const now = performance.now();
  mockVoices = mockVoices.filter((v) => !(v.stage === "fadeOut" && v.stoppedAt !== undefined && now - v.stoppedAt > 1000));
  const status: DeckStatus = {
    voices: mockVoices.map((v) => {
      const pos = (now - v.startedAt) / 1000;
      return {
        gen: v.gen,
        slotId: v.slotId,
        position: v.duration ? pos % v.duration : pos,
        duration: v.duration,
        stage: v.stage,
        env: v.stage === "fadeOut" ? 0.5 : 1,
      };
    }),
    peak: mockVoices.length ? [0.4 + Math.random() * 0.3, 0.4 + Math.random() * 0.3] : [0, 0],
    master: 1,
    duck: 1,
    underruns: 0,
  };
  mockEmit("deck-status", status);
  if (mockVoices.length === 0 && mockTimer) {
    clearInterval(mockTimer);
    mockTimer = null;
    mockEmit("deck-status", { ...status, voices: [], peak: [0, 0] });
  }
}

function ensureMockTimer() {
  if (!mockTimer) mockTimer = setInterval(mockTick, 50);
}

async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const a = args ?? {};
  switch (cmd) {
    case "audio_list_devices":
      return [
        { id: "Mock::Built-in Output", name: "Built-in Output", host: "Mock", maxChannels: 2, defaultSampleRate: 48000, isDefault: true },
        { id: "Mock::USB Interface", name: "USB Interface", host: "Mock", maxChannels: 8, defaultSampleRate: 48000, isDefault: false },
      ] as T;
    case "audio_restart":
      return { deviceId: (a.deviceId as string) || "Mock::Built-in Output", sampleRate: (a.sampleRate as number) || 48000, channels: 2 } as T;
    case "audio_get_channels":
      return 2 as T;
    case "slot_load": {
      const duration = 90 + (String(a.path).length % 7) * 20;
      mockSlots.set(a.slotId as string, { path: a.path as string, duration });
      const peaks = Array.from({ length: 240 }, (_, i) => 0.3 + 0.6 * Math.abs(Math.sin(i / 9) * Math.cos(i / 23)));
      return { duration, sampleRate: 48000, channels: 2, peaks } as T;
    }
    case "deck_play": {
      const now = performance.now();
      for (const v of mockVoices) {
        if (v.stage !== "fadeOut") {
          v.stage = "fadeOut";
          v.stoppedAt = now;
        }
      }
      const slot = mockSlots.get(a.slotId as string);
      if (!slot) throw new Error(`Slot ${String(a.slotId)} has no file`);
      const gen = mockGen++;
      mockVoices.push({ gen, slotId: a.slotId as string, startedAt: now, duration: slot.duration, stage: "steady" });
      ensureMockTimer();
      return gen as T;
    }
    case "deck_stop":
    case "deck_stop_slot": {
      const now = performance.now();
      for (const v of mockVoices) {
        if (cmd === "deck_stop_slot" && v.slotId !== a.slotId) continue;
        if (v.stage !== "fadeOut") {
          v.stage = "fadeOut";
          v.stoppedAt = now;
        }
      }
      return undefined as T;
    }
    case "osc_list_interfaces":
      return [{ name: "en0", address: "192.168.1.20" }, { name: "lo0", address: "127.0.0.1" }] as T;
    case "midi_list_inputs":
      return ["Mock Pad Controller"] as T;
    case "file_exists":
      return true as T;
    case "deck_read":
      throw new Error("No file system in browser mode");
    case "deck_pick_save_path":
    case "deck_pick_open_path":
    case "file_pick_audio":
      return null as T;
    case "dialog_confirm":
      return (typeof window !== "undefined" ? window.confirm(String(a.message)) : true) as T;
    case "dialog_message":
      if (typeof window !== "undefined") window.alert(String(a.message));
      return undefined as T;
    case "app_log_dir":
      return null as T;
    default:
      return undefined as T;
  }
}
