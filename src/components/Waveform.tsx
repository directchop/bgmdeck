import { memo } from "react";

interface Props {
  peaks: number[] | null;
  /** 0..1 played fraction, or null when not playing. */
  progress: number | null;
  color: string;
  /** Unique per instance (clipPath ids are document-global). */
  clipId: string;
  className?: string;
}

/** Mirrored peak outline, drawn once per pad; the progress overlay is a clip. */
export const Waveform = memo(function Waveform({ peaks, progress, color, clipId, className }: Props) {
  if (!peaks || peaks.length === 0) return null;
  const n = peaks.length;
  const w = 240;
  const h = 40;
  const mid = h / 2;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1 || 1)) * w;
    const a = Math.max(0.6, peaks[i] * (mid - 1));
    top.push(`${x.toFixed(1)},${(mid - a).toFixed(1)}`);
    bottom.unshift(`${x.toFixed(1)},${(mid + a).toFixed(1)}`);
  }
  const d = `M${top.join(" L")} L${bottom.join(" L")} Z`;
  const px = progress === null ? 0 : Math.min(1, Math.max(0, progress)) * w;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={className} aria-hidden>
      <path d={d} fill={color} fillOpacity={0.22} />
      {progress !== null && (
        <>
          <clipPath id={`wf-${clipId}`}>
            <rect x={0} y={0} width={px} height={h} />
          </clipPath>
          <path d={d} fill={color} fillOpacity={0.8} clipPath={`url(#wf-${clipId})`} />
          <line x1={px} x2={px} y1={0} y2={h} stroke={color} strokeWidth={1.5} />
        </>
      )}
    </svg>
  );
});
