const SHORTCUTS: [string, string][] = [
  ["1 – 9, 0", "Play pad 1–10 (tap a playing pad again to fade it out)"],
  ["Shift + click pad", "Restart the pad from the top"],
  ["Space", "Stop everything (fade). Works whatever is focused; never starts playback"],
  ["Shift + Space", "Stop now"],
  ["D", "Duck on / off"],
  ["[ / ]", "Previous / next bank"],
  ["Tab", "Switch Pads ⇄ Settings"],
  ["Enter", "Rename selected pad"],
  ["Delete / Backspace", "Clear selected pad"],
  ["Esc", "Deselect / close"],
  ["Drag pad onto pad", "Swap pads"],
  ["Drop audio files", "On a pad: assign (extra files fill the next pads). Elsewhere: fill empty pads"],
  ["Right-click pad", "Rename, colour, loop, choose file, clear"],
  ["Double-click a fader", "Reset to 0 dB"],
  ["Ctrl/⌘ + S", "Save deck"],
  ["Ctrl/⌘ + Shift + S", "Save deck as…"],
  ["Ctrl/⌘ + O", "Open deck"],
  ["Ctrl/⌘ + N", "New deck"],
  ["Ctrl/⌘ + Shift + N", "Add bank"],
  ["Ctrl/⌘ + Z / Shift + Z", "Undo / redo"],
  ["Ctrl/⌘ + 1 / 2", "Pads / Settings"],
  ["⌘ + ,", "Settings (macOS)"],
  ["?", "Show this help"],
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center" onMouseDown={onClose}>
      <div
        className="w-[520px] max-h-[80vh] overflow-y-auto bg-bg border border-border rounded-lg shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-xs tracking-wider uppercase text-text">Keyboard Shortcuts</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text text-sm" aria-label="Close">×</button>
        </div>
        <dl className="px-4 py-2">
          {SHORTCUTS.map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
              <dt className="text-[11px] text-text-dim">{desc}</dt>
              <dd className="shrink-0 text-[10px] font-mono text-text bg-surface border border-border rounded px-1.5 py-0.5">{key}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
