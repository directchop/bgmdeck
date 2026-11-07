import { slotLabel } from "../deckFile";
import { formatTime } from "../format";
import { padColorHex } from "../padColors";
import { findSlot, useDeckStore } from "../store/deck";

export function NowPlaying() {
  const voices = useDeckStore((s) => s.voices);
  const banks = useDeckStore((s) => s.banks);
  const stopSlot = useDeckStore((s) => s.stopSlot);
  const underruns = useDeckStore((s) => s.underruns);

  const sorted = voices.slice().sort((a, b) => b.gen - a.gen);
  return (
    <footer className="h-12 px-3 border-t border-border bg-bg-dark flex items-center gap-4 overflow-hidden">
      {sorted.length === 0 ? (
        <span className="text-[11px] text-text-muted">Nothing playing — press 1–0 or click a pad. Space fades out, D ducks.</span>
      ) : (
        sorted.map((v) => {
          const found = findSlot(banks, v.slotId);
          if (!found) return null;
          const color = padColorHex(found.slot.color);
          const duration = v.duration ?? found.slot.duration;
          const pct = duration ? Math.min(100, (v.position / duration) * 100) : 0;
          const out = v.stage === "fadeOut";
          return (
            <div key={v.gen} className={`flex items-center gap-3 min-w-0 ${out ? "opacity-50" : ""}`} style={{ flex: out ? "0 1 220px" : "1 1 0" }}>
              <span className="w-1.5 h-8 rounded-sm" style={{ background: color }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="truncate text-[13px] text-text">{slotLabel(found.slot)}</span>
                  <span className="text-[10px] text-text-dim shrink-0">
                    {found.bank.name} · pad {found.slotIndex + 1}
                    {out ? " · fading out" : v.stage === "fadeIn" ? " · fading in" : ""}
                  </span>
                </div>
                <div className="h-1 mt-1 bg-bg-darker rounded-sm overflow-hidden">
                  <div className="h-full" style={{ width: `${pct}%`, background: color }} />
                </div>
              </div>
              <span className="font-mono text-[12px] tabular-nums text-text shrink-0">
                {formatTime(v.position)}
                <span className="text-text-dim"> / {formatTime(duration)}</span>
              </span>
              {!out && (
                <button
                  onClick={() => void stopSlot(v.slotId)}
                  className="h-7 px-2 rounded bg-surface text-[11px] text-text hover:bg-red/80 hover:text-white shrink-0"
                  title="Fade this out"
                >
                  Fade out
                </button>
              )}
            </div>
          );
        })
      )}
      {underruns > 0 && (
        <span className="ml-auto text-[10px] text-yellow shrink-0" title="The decoder could not keep up; try a larger buffer size or a faster disk.">
          {underruns} dropout{underruns === 1 ? "" : "s"}
        </span>
      )}
    </footer>
  );
}
