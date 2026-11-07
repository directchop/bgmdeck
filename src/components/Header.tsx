import { audioDeviceLabel } from "../bridge";
import { saveDeck } from "../deckIO";
import { usePrefsStore } from "../prefsStore";
import { useDeckStore } from "../store/deck";
import { useUiStore } from "../uiStore";
import { installUpdate, useUpdateStatus } from "../updater";
import { Fader } from "./Fader";
import { Meter } from "./Meter";

function Btn({
  title,
  onClick,
  children,
  active,
  tone = "neutral",
  disabled,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  tone?: "neutral" | "danger" | "accent";
  disabled?: boolean;
}) {
  const cls = active
    ? tone === "accent"
      ? "bg-accent text-black shadow-[0_0_12px_rgba(255,159,28,0.45)]"
      : "bg-surface-light text-text"
    : tone === "danger"
      ? "bg-surface text-text hover:bg-red/80 hover:text-white"
      : "bg-surface text-text hover:bg-surface-light";
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`h-8 px-3 rounded-md text-[12px] font-medium transition-colors disabled:opacity-40 ${cls}`}
    >
      {children}
    </button>
  );
}

export function Header() {
  const name = useDeckStore((s) => s.name);
  const dirty = useDeckStore((s) => s.dirty);
  const playing = useDeckStore((s) => s.voices.length > 0);
  const duckOn = useDeckStore((s) => s.duckOn);
  const master = useDeckStore((s) => s.settings.master);
  const setMaster = useDeckStore((s) => s.setMaster);
  const stop = useDeckStore((s) => s.stop);
  const stopNow = useDeckStore((s) => s.stopNow);
  const toggleDuck = useDeckStore((s) => s.toggleDuck);
  const engineStarted = useDeckStore((s) => s.engineStarted);
  const engineError = useDeckStore((s) => s.engineError);
  const applied = usePrefsStore((s) => s.applied);
  const tab = useUiStore((s) => s.tab);
  const setTab = useUiStore((s) => s.setTab);
  const update = useUpdateStatus();

  return (
    <header className="flex items-center gap-3 h-14 px-3 border-b border-border bg-bg">
      <div className="min-w-0 w-48">
        <div className="truncate text-[13px] text-text" title={name}>
          {name}
          {dirty && <span className="text-accent" title="Unsaved changes"> •</span>}
        </div>
        <button
          onClick={() => setTab("settings")}
          title={engineError ?? (applied ? `${applied.sampleRate} Hz · ${applied.channels} ch` : "Audio not started")}
          className={`truncate text-[10px] ${engineError ? "text-red" : engineStarted ? "text-text-dim" : "text-yellow"} hover:text-text`}
        >
          {engineError ? "⚠ " : ""}
          {engineStarted ? audioDeviceLabel(applied?.deviceId) : "Audio not running"}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <Btn title="Stop with fade (Space)" onClick={() => void stop()} tone="danger" disabled={!playing}>
          ■ Stop
        </Btn>
        <Btn title="Stop immediately (Shift+Space)" onClick={() => void stopNow()} tone="danger" disabled={!playing}>
          ■ Now
        </Btn>
        <Btn title="Duck — lower the music under an announcement (D)" onClick={toggleDuck} active={duckOn} tone="accent">
          Duck
        </Btn>
      </div>

      <div className="flex-1" />

      {update.state === "available" && (
        <button
          onClick={() => void installUpdate()}
          className="h-7 px-2 rounded bg-accent/15 border border-accent/40 text-accent text-[11px] hover:bg-accent/25"
          title={update.notes || "Install update"}
        >
          Update {update.version} available
        </button>
      )}
      {update.state === "downloading" && (
        <span className="text-[11px] text-text-dim">
          Downloading{update.progress !== undefined ? ` ${Math.round(update.progress * 100)}%` : "…"}
        </span>
      )}

      <div className="flex items-center gap-3 w-72">
        <span className="text-[10px] uppercase tracking-wider text-text-dim">Master</span>
        <Fader gain={master} onChange={setMaster} className="flex-1" title="Master volume" />
      </div>
      <Meter className="w-20" />

      <div className="flex items-center gap-1 ml-2">
        <button
          onClick={() => void saveDeck()}
          title="Save (Ctrl/⌘+S)"
          className={`h-7 px-2 rounded text-[11px] ${dirty ? "text-accent hover:bg-accent/15" : "text-text-muted hover:text-text"}`}
        >
          Save
        </button>
        <button
          onClick={() => setTab(tab === "settings" ? "pads" : "settings")}
          title="Settings (Tab)"
          className={`h-7 w-7 rounded text-[14px] ${tab === "settings" ? "bg-surface-light text-text" : "text-text-dim hover:text-text"}`}
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
