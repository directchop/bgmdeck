import { memo, useEffect, useRef, useState } from "react";
import { chooseFileForSlot } from "../commands";
import { fileNameOf, slotLabel } from "../deckFile";
import { formatTime } from "../format";
import { padColorHex } from "../padColors";
import { useDeckStore } from "../store/deck";
import { PAD_COLORS, type PlayingVoice, type Slot } from "../store/types";
import { useUiStore } from "../uiStore";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { Fader } from "./Fader";
import { Waveform } from "./Waveform";
import { beginPadDrag, padDragConsumedClick } from "../padDrag";

interface Props {
  slot: Slot;
  index: number;
  voice: PlayingVoice | null;
  selected: boolean;
  dragOver: boolean;
  showWaveform: boolean;
}

const KEY_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

export const Pad = memo(function Pad({ slot, index, voice, selected, dragOver, showWaveform }: Props) {
  const play = useDeckStore((s) => s.play);
  const selectSlot = useDeckStore((s) => s.selectSlot);
  const setSlotVolume = useDeckStore((s) => s.setSlotVolume);
  const setSlotLoop = useDeckStore((s) => s.setSlotLoop);
  const setSlotName = useDeckStore((s) => s.setSlotName);
  const setSlotColor = useDeckStore((s) => s.setSlotColor);
  const clearSlot = useDeckStore((s) => s.clearSlot);
  const swapSlots = useDeckStore((s) => s.swapSlots);
  const renamingSlotId = useUiStore((s) => s.renamingSlotId);
  const setRenamingSlotId = useUiStore((s) => s.setRenamingSlotId);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const renaming = renamingSlotId === slot.id;

  useEffect(() => {
    if (renaming) {
      setDraft(slot.name || slotLabel(slot));
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [renaming, slot]);

  const color = padColorHex(slot.color);
  const empty = !slot.path;
  const playing = !!voice && voice.stage !== "fadeOut";
  const fading = !!voice && voice.stage === "fadeOut";
  const duration = voice?.duration ?? slot.duration;
  const progress = voice && duration ? voice.position / duration : null;
  const remaining = voice && duration ? duration - voice.position : null;
  const label = slotLabel(slot);

  const onClick = (e: React.MouseEvent) => {
    selectSlot(slot.id);
    if (empty) {
      void chooseFileForSlot(slot.id);
      return;
    }
    if (slot.missing || slot.error) return;
    void play(slot.id, { restart: e.shiftKey });
  };

  const commitRename = () => {
    if (renaming) setSlotName(slot.id, draft.trim());
    setRenamingSlotId(null);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || empty || renaming) return;
    beginPadDrag(slot.id, e.clientX, e.clientY, swapSlots);
  };

  const entries: MenuEntry[] = [
    { label: empty ? "Choose audio file…" : "Replace audio file…", onSelect: () => void chooseFileForSlot(slot.id) },
    { label: "Rename", disabled: empty, onSelect: () => setRenamingSlotId(slot.id) },
    { label: "Loop", checked: slot.loop, onSelect: () => setSlotLoop(slot.id, !slot.loop) },
    { separator: true },
    ...PAD_COLORS.map<MenuEntry>((c) => ({
      label: c[0].toUpperCase() + c.slice(1),
      swatch: padColorHex(c),
      checked: slot.color === c,
      onSelect: () => setSlotColor(slot.id, c),
    })),
    { label: "No colour", checked: slot.color === null, onSelect: () => setSlotColor(slot.id, null) },
    { separator: true },
    { label: "Clear pad", disabled: empty, onSelect: () => clearSlot(slot.id) },
  ];

  const ring = selected ? "ring-2 ring-accent/70" : "";
  const base = empty
    ? "border-dashed border-border-light bg-bg-dark/60 hover:bg-surface/60"
    : playing
      ? "border-transparent"
      : "border-border bg-surface hover:bg-surface-light";

  return (
    <>
      <div
        className={`pad relative flex flex-col rounded-lg border overflow-hidden min-h-[120px] cursor-pointer transition-colors ${base} ${ring}`}
        style={
          playing
            ? { background: `linear-gradient(180deg, ${color}33, ${color}1f)`, boxShadow: `0 0 0 1px ${color}aa, 0 0 22px ${color}55` }
            : fading
              ? { boxShadow: `inset 0 0 0 1px ${color}66` }
              : undefined
        }
        data-slot-id={slot.id}
        data-drag-over={dragOver || undefined}
        onClick={(e) => {
          if (padDragConsumedClick()) return;
          onClick(e);
        }}
        onPointerDown={onPointerDown}
        onContextMenu={(e) => {
          e.preventDefault();
          selectSlot(slot.id);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={slot.path ?? "Click to choose a file, or drop audio here"}
      >
        {/* colour bar */}
        {!empty && <div className="absolute left-0 top-0 bottom-0 w-1" style={{ background: color }} />}

        {/* waveform */}
        {showWaveform && !empty && (
          <div className="absolute inset-x-2 bottom-9 h-10 pointer-events-none">
            <Waveform peaks={slot.peaks} progress={progress} color={color} clipId={slot.id} className="w-full h-full" />
          </div>
        )}

        {/* header row */}
        <div className="relative flex items-start gap-2 px-3 pt-2">
          <span
            className="font-mono text-[11px] leading-5 px-1.5 rounded"
            style={{ background: playing ? color : "var(--color-bg-darker)", color: playing ? "#111" : "var(--color-text-dim)" }}
          >
            {KEY_LABELS[index] ?? index + 1}
          </span>
          <div className="flex-1 min-w-0">
            {renaming ? (
              <input
                ref={inputRef}
                className="w-full bg-bg-darker border border-border rounded px-1 text-[13px] text-text outline-none"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenamingSlotId(null);
                }}
              />
            ) : (
              <div
                className={`truncate text-[13px] font-medium ${empty ? "text-text-muted italic" : "text-text"}`}
                onDoubleClick={(e) => {
                  if (empty) return;
                  e.stopPropagation();
                  setRenamingSlotId(slot.id);
                }}
              >
                {empty ? "Empty — click or drop audio" : label}
              </div>
            )}
            {!empty && (
              <div className="truncate text-[10px] text-text-dim">
                {slot.missing ? (
                  <span className="text-red">Missing: {fileNameOf(slot.path!)}</span>
                ) : slot.error ? (
                  <span className="text-red">{slot.error}</span>
                ) : (
                  <>
                    {slot.name ? fileNameOf(slot.path!) : ""}
                    {slot.name ? " · " : ""}
                    {slot.duration === null ? "measuring…" : formatTime(slot.duration)}
                    {slot.loop ? " · loop" : ""}
                  </>
                )}
              </div>
            )}
          </div>
          {!empty && (
            <button
              className={`text-[10px] px-1.5 h-5 rounded border ${slot.loop ? "border-accent/60 text-accent" : "border-border text-text-muted hover:text-text"}`}
              title="Loop"
              onClick={(e) => {
                e.stopPropagation();
                setSlotLoop(slot.id, !slot.loop);
              }}
            >
              ⟳
            </button>
          )}
        </div>

        {/* time readout */}
        {voice && (
          <div className="relative mt-auto px-3 pb-9 font-mono text-[11px] tabular-nums text-text">
            {fading ? (
              <span className="text-text-dim pulse-soft">fading out…</span>
            ) : (
              <>
                {formatTime(voice.position)}
                <span className="text-text-dim"> / {formatTime(duration)}</span>
                {remaining !== null && !slot.loop && <span className="text-text-dim"> · −{formatTime(remaining)}</span>}
              </>
            )}
          </div>
        )}

        {/* volume */}
        {!empty && (
          <div className="absolute inset-x-2 bottom-1.5" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            <Fader
              gain={slot.volume}
              onChange={(g) => setSlotVolume(slot.id, g, false)}
              title="Pad volume"
            />
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries} onClose={() => setMenu(null)} />}
    </>
  );
});
