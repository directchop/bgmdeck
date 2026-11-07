import { useEffect, useState, useSyncExternalStore } from "react";
import {
  appLogDir,
  audioDeviceLabel,
  audioListDevices,
  audioRestart,
  midiListInputs,
  openPath,
  openUrl,
  oscListInterfaces,
  type AudioDeviceInfo,
  type NetInterface,
} from "../bridge";
import { DOCS_URL } from "../commands";
import { seedEngine } from "../engineSync";
import { gainToDb } from "../format";
import { assignNote, midiLearn, noteName, type MidiTarget } from "../midiMap";
import { OSC_REFERENCE, oscLog, subscribeOscLog } from "../oscReceive";
import { usePrefsStore } from "../prefsStore";
import { useDeckStore } from "../store/deck";
import type { FadeCurve } from "../store/types";
import { useUiStore, type SettingsSection } from "../uiStore";
import { UPDATES_ENABLED, checkForUpdates, installUpdate, useUpdateStatus } from "../updater";
import { loadUpdatePrefs, saveUpdatePrefs } from "../updatePolicy";
import { Fader } from "./Fader";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "audio", label: "Audio" },
  { id: "fades", label: "Fades & Duck" },
  { id: "remote", label: "Remote (OSC / MIDI)" },
  { id: "updates", label: "Updates" },
  { id: "about", label: "About" },
];

const SAMPLE_RATES = [0, 44100, 48000, 96000];
const BUFFER_SIZES = [0, 128, 256, 512, 1024, 2048];

const field = "bg-bg-darker border border-border rounded px-2 py-1 text-[12px] text-text outline-none focus:border-accent";
const button = "px-3 py-1.5 text-[11px] rounded border border-border-light text-text hover:border-accent disabled:opacity-40";
const h3 = "text-xs text-text tracking-wider uppercase mb-3";
const help = "text-[10px] text-text-dim leading-relaxed";

export function SettingsView() {
  const section = useUiStore((s) => s.settingsSection);
  const setSection = useUiStore((s) => s.setSettingsSection);
  return (
    <div className="flex-1 min-h-0 flex">
      <nav className="w-44 border-r border-border bg-bg-dark py-2">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`block w-full text-left px-4 py-2 text-[12px] ${section === s.id ? "bg-surface-light text-text" : "text-text-dim hover:text-text hover:bg-surface"}`}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 min-w-0 overflow-y-auto p-6 space-y-8">
        {section === "audio" && <AudioSection />}
        {section === "fades" && <FadesSection />}
        {section === "remote" && (
          <>
            <OscSection />
            <MidiSection />
          </>
        )}
        {section === "updates" && (UPDATES_ENABLED ? <UpdatesSection /> : <p className={help}>Updates are disabled in this build.</p>)}
        {section === "about" && <AboutSection />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function NumberInput({ value, onChange, min = 0, max = 60, step = 0.1, unit = "s", width = "w-20" }: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  width?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const v = Number(draft);
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
    else setDraft(String(value));
  };
  return (
    <span className="inline-flex items-center gap-1">
      <input
        className={`${field} ${width} text-right font-mono`}
        value={draft}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <span className="text-[10px] text-text-dim">{unit}</span>
    </span>
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-start gap-4 py-2 border-b border-border/50 last:border-0">
      <div className="w-44 shrink-0 pt-1">
        <div className="text-[12px] text-text">{label}</div>
        {hint && <div className={help}>{hint}</div>}
      </div>
      <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AudioSection() {
  const audio = usePrefsStore((s) => s.audio);
  const setAudio = usePrefsStore((s) => s.setAudio);
  const applied = usePrefsStore((s) => s.applied);
  const setApplied = usePrefsStore((s) => s.setApplied);
  const engineStarted = useDeckStore((s) => s.engineStarted);
  const engineError = useDeckStore((s) => s.engineError);
  const setEngineStarted = useDeckStore((s) => s.setEngineStarted);
  const playing = useDeckStore((s) => s.voices.length > 0);
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const refresh = async () => setDevices(await audioListDevices().catch(() => []));
  useEffect(() => {
    void refresh();
  }, []);

  const selected = devices.find((d) => d.id === audio.deviceId);
  const channels = applied?.channels ?? selected?.maxChannels ?? 2;
  const hosts = Array.from(new Set(devices.map((d) => d.host)));

  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const a = await audioRestart(audio.deviceId, audio.sampleRate || null, audio.bufferSize || null);
      setApplied(a);
      setEngineStarted(true, null);
      seedEngine();
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <section>
      <h3 className={h3}>Audio output</h3>
      <Row label="Output device">
        <select className={`${field} min-w-[260px]`} value={audio.deviceId ?? ""} onChange={(e) => setAudio({ deviceId: e.target.value || null })}>
          <option value="">System default</option>
          {hosts.map((host) => (
            <optgroup key={host} label={host}>
              {devices.filter((d) => d.host === host).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.maxChannels} ch{d.isDefault ? ", default" : ""})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button className={button} onClick={() => void refresh()}>↻ Refresh</button>
      </Row>
      <Row label="Sample rate">
        <select className={field} value={audio.sampleRate} onChange={(e) => setAudio({ sampleRate: Number(e.target.value) })}>
          {SAMPLE_RATES.map((r) => (
            <option key={r} value={r}>{r === 0 ? "Device default" : `${r / 1000} kHz`}</option>
          ))}
        </select>
      </Row>
      <Row label="Buffer size" hint="Larger = safer on a busy machine. BGM does not need low latency.">
        <select className={field} value={audio.bufferSize} onChange={(e) => setAudio({ bufferSize: Number(e.target.value) })}>
          {BUFFER_SIZES.map((b) => (
            <option key={b} value={b}>{b === 0 ? "Device default" : `${b} frames`}</option>
          ))}
        </select>
      </Row>
      <Row label="Output channels" hint="Which physical outputs carry the deck's left / right.">
        <label className="text-[11px] text-text-dim">L</label>
        <select className={field} value={audio.left} onChange={(e) => setAudio({ left: Number(e.target.value) })}>
          {Array.from({ length: Math.max(2, channels) }, (_, i) => (
            <option key={i} value={i}>Out {i + 1}</option>
          ))}
        </select>
        <label className="text-[11px] text-text-dim ml-2">R</label>
        <select className={field} value={audio.right} onChange={(e) => setAudio({ right: Number(e.target.value) })}>
          {Array.from({ length: Math.max(2, channels) }, (_, i) => (
            <option key={i} value={i}>Out {i + 1}</option>
          ))}
        </select>
        <span className={help}>Channel routing applies immediately.</span>
      </Row>
      <Row label="">
        <button className={`${button} ${!engineStarted ? "border-accent text-accent" : ""}`} onClick={() => void apply()} disabled={applying || playing} title={playing ? "Stop playback first" : ""}>
          {applying ? "Applying…" : engineStarted ? "Apply device / rate / buffer" : "Start audio"}
        </button>
        <span className={help}>
          {applied ? `Running: ${audioDeviceLabel(applied.deviceId)} · ${applied.sampleRate} Hz · ${applied.channels} ch` : "Audio is not running."}
          {playing ? " Applying stops playback, so it is disabled while a pad plays." : ""}
        </span>
      </Row>
      {(applyError || engineError) && <p className="mt-2 text-[11px] text-red">{applyError ?? engineError}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------

function FadesSection() {
  const settings = useDeckStore((s) => s.settings);
  const update = useDeckStore((s) => s.updateSettings);
  return (
    <section>
      <h3 className={h3}>Fades &amp; duck (saved in the deck)</h3>
      <Row label="Crossfade" hint="Pressing a pad while another plays.">
        <NumberInput value={settings.crossfadeSec} onChange={(v) => update({ crossfadeSec: v })} />
      </Row>
      <Row label="Fade in from silence" hint="When nothing was playing.">
        <NumberInput value={settings.startFadeSec} onChange={(v) => update({ startFadeSec: v })} />
      </Row>
      <Row label="Stop fade" hint="Space / Stop button / OSC stop.">
        <NumberInput value={settings.stopFadeSec} onChange={(v) => update({ stopFadeSec: v })} />
      </Row>
      <Row label="Fade curve">
        <select className={field} value={settings.fadeCurve} onChange={(e) => update({ fadeCurve: e.target.value as FadeCurve })}>
          <option value="equal-power">Equal power (constant loudness)</option>
          <option value="linear">Linear</option>
          <option value="s-curve">S-curve</option>
        </select>
      </Row>
      <Row label="Duck level" hint="Music level while Duck is on.">
        <Fader gain={settings.duckLevel} onChange={(g) => useDeckStore.setState((s) => ({ settings: { ...s.settings, duckLevel: g }, dirty: true }))} className="w-64" />
      </Row>
      <Row label="Duck fade">
        <NumberInput value={settings.duckFadeSec} onChange={(v) => update({ duckFadeSec: v })} />
      </Row>
      <Row label="Tap to stop" hint="Clicking or keying the pad that is playing fades it out. Shift restarts it.">
        <label className="flex items-center gap-2 text-[12px] text-text">
          <input type="checkbox" checked={settings.tapToStop} onChange={(e) => update({ tapToStop: e.target.checked })} /> enabled
        </label>
      </Row>
    </section>
  );
}

// ---------------------------------------------------------------------------

function OscSection() {
  const remote = usePrefsStore((s) => s.remote);
  const setRemote = usePrefsStore((s) => s.setRemote);
  const oscError = usePrefsStore((s) => s.oscError);
  const [ifaces, setIfaces] = useState<NetInterface[]>([]);
  const [targetsDraft, setTargetsDraft] = useState(remote.oscFeedbackTargets.join("\n"));
  const log = useSyncExternalStore(subscribeOscLog, oscLog);
  const [portDraft, setPortDraft] = useState(String(remote.oscPort));

  useEffect(() => {
    void oscListInterfaces().then(setIfaces).catch(() => {});
  }, []);
  useEffect(() => setPortDraft(String(remote.oscPort)), [remote.oscPort]);

  const commitPort = () => {
    const p = Number(portDraft);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) setRemote({ oscPort: p });
    else setPortDraft(String(remote.oscPort));
  };

  const commitTargets = () => {
    const list = targetsDraft.split(/[\n,;]+/).map((t) => t.trim()).filter(Boolean);
    setRemote({ oscFeedbackTargets: list });
    setTargetsDraft(list.join("\n"));
  };

  return (
    <section>
      <h3 className={h3}>OSC</h3>
      <Row label="Receive" hint="Control BGM Deck from playque, TouchOSC, QLab, Companion…">
        <label className="flex items-center gap-2 text-[12px] text-text">
          <input type="checkbox" checked={remote.oscEnabled} onChange={(e) => setRemote({ oscEnabled: e.target.checked })} /> listen on UDP port
        </label>
        <input
          className={`${field} w-20 font-mono text-right`}
          value={portDraft}
          onChange={(e) => setPortDraft(e.target.value)}
          onBlur={commitPort}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <select className={field} value={remote.oscInterface} onChange={(e) => setRemote({ oscInterface: e.target.value })} title="Network interface">
          <option value="">Every interface</option>
          {ifaces.map((i) => (
            <option key={i.name} value={i.name}>{i.name} ({i.address})</option>
          ))}
        </select>
        {remote.oscEnabled && (
          <span className={`text-[11px] ${oscError ? "text-red" : "text-green"}`}>{oscError ?? "● listening"}</span>
        )}
      </Row>
      <Row label="State feedback" hint="One ip:port per line. Sends /bgmdeck/state on every change and once a second while playing.">
        <textarea
          className={`${field} w-72 h-16 font-mono`}
          value={targetsDraft}
          placeholder={"192.168.1.10:9000"}
          onChange={(e) => setTargetsDraft(e.target.value)}
          onBlur={commitTargets}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </Row>
      <div className="mt-4">
        <div className="text-[11px] text-text mb-1">Addresses (pads and banks are numbered from 1)</div>
        <table className="w-full text-[11px]">
          <tbody>
            {OSC_REFERENCE.map(([addr, desc]) => (
              <tr key={addr} className="border-b border-border/40">
                <td className="py-1 pr-4 font-mono text-text whitespace-nowrap">{addr}</td>
                <td className="py-1 text-text-dim">{desc}</td>
              </tr>
            ))}
            <tr>
              <td className="py-1 pr-4 font-mono text-text whitespace-nowrap">/bgmdeck/state …</td>
              <td className="py-1 text-text-dim">Feedback: state bank pad name position duration</td>
            </tr>
          </tbody>
        </table>
        <p className={`${help} mt-2`}>
          From playque: add an OSC track targeting this machine and this port; a cue with <span className="font-mono">/bgmdeck/stop</span> fades the BGM when the show starts.
        </p>
      </div>
      <div className="mt-4">
        <div className="text-[11px] text-text mb-1">Received (latest first)</div>
        <div className="h-28 overflow-y-auto bg-bg-darker border border-border rounded p-2 font-mono text-[10px]">
          {log.length === 0 ? (
            <span className="text-text-muted">No OSC received yet.</span>
          ) : (
            log.map((e, i) => (
              <div key={`${e.at}-${i}`} className={e.handled ? "text-text" : "text-text-muted"}>
                <span className="text-text-dim">{new Date(e.at).toLocaleTimeString()} </span>
                {e.address} {e.args}
                <span className="text-text-dim"> ← {e.from}{e.handled ? "" : " (ignored)"}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

const MIDI_ROWS: { target: MidiTarget; label: string }[] = [
  ...Array.from({ length: 10 }, (_, i) => ({ target: { kind: "pad", index: i } as MidiTarget, label: `Pad ${i + 1}` })),
  { target: { kind: "stop" }, label: "Stop (fade)" },
  { target: { kind: "stopNow" }, label: "Stop now" },
  { target: { kind: "duck" }, label: "Duck toggle" },
  { target: { kind: "bankPrev" }, label: "Previous bank" },
  { target: { kind: "bankNext" }, label: "Next bank" },
];

function noteFor(map: ReturnType<typeof usePrefsStore.getState>["remote"]["midi"], t: MidiTarget): number {
  switch (t.kind) {
    case "pad":
      return map.padNotes[t.index] ?? -1;
    case "stop":
      return map.stopNote;
    case "stopNow":
      return map.stopNowNote;
    case "duck":
      return map.duckNote;
    case "bankPrev":
      return map.bankPrevNote;
    case "bankNext":
      return map.bankNextNote;
  }
}

const sameTarget = (a: MidiTarget | null, b: MidiTarget) => !!a && a.kind === b.kind && (a.kind !== "pad" || b.kind !== "pad" || a.index === b.index);

function MidiSection() {
  const remote = usePrefsStore((s) => s.remote);
  const setRemote = usePrefsStore((s) => s.setRemote);
  const setMidiMap = usePrefsStore((s) => s.setMidiMap);
  const midiError = usePrefsStore((s) => s.midiError);
  const [inputs, setInputs] = useState<string[]>([]);
  const learnTarget = useSyncExternalStore(midiLearn.subscribe, midiLearn.target);
  const lastNote = useSyncExternalStore(midiLearn.subscribe, midiLearn.lastNote);

  const refresh = () => void midiListInputs().then(setInputs).catch(() => {});
  useEffect(refresh, []);

  return (
    <section>
      <h3 className={h3}>MIDI</h3>
      <Row label="Input">
        <select className={`${field} min-w-[220px]`} value={remote.midiInput ?? ""} onChange={(e) => setRemote({ midiInput: e.target.value || null })}>
          <option value="">Off</option>
          {inputs.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
          {remote.midiInput && !inputs.includes(remote.midiInput) && <option value={remote.midiInput}>{remote.midiInput} (not connected)</option>}
        </select>
        <button className={button} onClick={refresh}>↻ Refresh</button>
        {remote.midiInput && <span className={`text-[11px] ${midiError ? "text-red" : "text-green"}`}>{midiError ?? "● connected"}</span>}
      </Row>
      <Row label="Channel">
        <select className={field} value={remote.midi.channel} onChange={(e) => setMidiMap({ channel: Number(e.target.value) })}>
          <option value={0}>Any</option>
          {Array.from({ length: 16 }, (_, i) => (
            <option key={i + 1} value={i + 1}>{i + 1}</option>
          ))}
        </select>
        <span className={help}>
          Last note: {lastNote ? `${noteName(lastNote.note)} (${lastNote.note}) ch ${lastNote.channel} vel ${lastNote.velocity}` : "—"}
        </span>
      </Row>
      <div className="mt-3 grid grid-cols-2 gap-x-8">
        {MIDI_ROWS.map(({ target, label }) => {
          const note = noteFor(remote.midi, target);
          const learning = sameTarget(learnTarget, target);
          return (
            <div key={label} className="flex items-center gap-2 py-1 border-b border-border/40 text-[12px]">
              <span className="w-28 text-text">{label}</span>
              <span className="w-20 font-mono text-text-dim">{note < 0 ? "—" : `${noteName(note)} (${note})`}</span>
              <button
                className={`${button} ${learning ? "border-accent text-accent pulse-soft" : ""}`}
                onClick={() => (learning ? midiLearn.cancel() : midiLearn.start(target))}
              >
                {learning ? "Press a key…" : "Learn"}
              </button>
              {note >= 0 && (
                <button className="text-[11px] text-text-muted hover:text-text" onClick={() => setMidiMap(assignNote(remote.midi, target, -1))} title="Unassign">×</button>
              )}
            </div>
          );
        })}
      </div>
      <p className={`${help} mt-2`}>Note On messages trigger; velocity is ignored. Defaults follow a typical pad controller (note 36 = C2 = pad 1).</p>
    </section>
  );
}

// ---------------------------------------------------------------------------

function UpdatesSection() {
  const status = useUpdateStatus();
  const playing = useDeckStore((s) => s.voices.length > 0);
  const [prefs, setPrefs] = useState(loadUpdatePrefs);
  const update = (patch: Partial<typeof prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveUpdatePrefs(next);
  };
  const busy = status.state === "checking" || status.state === "downloading";
  return (
    <section>
      <h3 className={h3}>Updates</h3>
      <div className="flex items-center gap-3 mb-3">
        <span className="text-[12px] text-text">BGM Deck {__APP_VERSION__}</span>
        <button className={button} onClick={() => void checkForUpdates()} disabled={busy || playing} title={playing ? "Stop playback first" : ""}>
          {status.state === "checking" ? "Checking…" : "Check for updates"}
        </button>
        {status.state === "available" && (
          <button className={`${button} border-accent text-accent`} onClick={() => void installUpdate()} disabled={playing}>
            Install {status.version} and relaunch
          </button>
        )}
      </div>
      <p className="text-[11px] text-text-dim mb-3">
        {status.state === "none" && "You are up to date."}
        {status.state === "available" && `Version ${status.version} is available.${status.notes ? ` ${status.notes}` : ""}`}
        {status.state === "downloading" && `Downloading… ${status.progress !== undefined ? Math.round(status.progress * 100) + "%" : ""}`}
        {status.state === "error" && <span className="text-red">{status.error}</span>}
      </p>
      <label className="flex items-center gap-2 text-[12px] text-text py-1">
        <input type="checkbox" checked={prefs.checkOnStartup} onChange={(e) => update({ checkOnStartup: e.target.checked })} /> Check on startup
      </label>
      <label className="flex items-center gap-2 text-[12px] text-text py-1">
        <input type="checkbox" checked={prefs.channel === "beta"} onChange={(e) => update({ channel: e.target.checked ? "beta" : "stable" })} /> Include beta releases
      </label>
      <p className={`${help} mt-2`}>Nothing is downloaded until you click Install, and updates are blocked while a pad is playing.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------

function AboutSection() {
  const [logDir, setLogDir] = useState<string | null>(null);
  useEffect(() => {
    void appLogDir().then(setLogDir).catch(() => {});
  }, []);
  return (
    <section>
      <h3 className={h3}>About</h3>
      <p className="text-[12px] text-text">BGM Deck {__APP_VERSION__}</p>
      <p className={`${help} mt-1`}>Pad-style background music player for live events. Streams any length of audio, crossfades at sample accuracy, and takes OSC / MIDI from the rest of the show.</p>
      <div className="flex gap-2 mt-4">
        <button className={button} onClick={() => void openUrl(DOCS_URL)}>Online manual</button>
        <button className={button} onClick={() => void openUrl("https://github.com/directchop/bgmdeck/releases")}>Release notes</button>
        <button className={button} onClick={() => logDir && void openPath(logDir)} disabled={!logDir}>Open log folder</button>
      </div>
      {logDir && <p className={`${help} mt-2 font-mono`}>{logDir}</p>}
      <p className={`${help} mt-6`}>© 2026 Hajime Sugie. Companion to playque.</p>
    </section>
  );
}
