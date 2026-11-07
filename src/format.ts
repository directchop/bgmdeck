export function formatTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "--:--";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** Linear gain → dB label ("-6.0 dB", "-inf"). */
export function gainToDb(gain: number): string {
  if (gain <= 0.0005) return "-∞ dB";
  const db = 20 * Math.log10(gain);
  return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

/** Fader position 0..1 → gain 0..1 with a usable taper (−60 dB at 0.05). */
export function faderToGain(x: number): number {
  const v = Math.min(1, Math.max(0, x));
  if (v <= 0) return 0;
  return Math.pow(v, 2.5);
}

export function gainToFader(g: number): number {
  const v = Math.min(1, Math.max(0, g));
  return Math.pow(v, 1 / 2.5);
}
