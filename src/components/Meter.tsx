import { useDeckStore } from "../store/deck";

function Bar({ level }: { level: number }) {
  const db = level > 0 ? 20 * Math.log10(level) : -90;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const tone = db > -3 ? "bg-red" : db > -12 ? "bg-yellow" : "bg-green";
  return (
    <div className="h-1.5 w-full bg-bg-dark rounded-sm overflow-hidden">
      <div className={`h-full ${tone} transition-[width] duration-75`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Stereo output peak meter (deck output, post master). */
export function Meter({ className = "" }: { className?: string }) {
  const peak = useDeckStore((s) => s.peak);
  return (
    <div className={`flex flex-col gap-1 ${className}`} title="Output level">
      <Bar level={peak[0]} />
      <Bar level={peak[1]} />
    </div>
  );
}
