import { faderToGain, gainToDb, gainToFader } from "../format";

interface Props {
  gain: number;
  onChange: (gain: number) => void;
  onCommit?: () => void;
  className?: string;
  disabled?: boolean;
  title?: string;
  showDb?: boolean;
}

/** Horizontal fader with an audio taper and a dB readout. */
export function Fader({ gain, onChange, onCommit, className = "", disabled, title, showDb = true }: Props) {
  return (
    <div className={`flex items-center gap-2 ${className}`} title={title}>
      <input
        type="range"
        className="fader flex-1"
        min={0}
        max={1000}
        step={1}
        value={Math.round(gainToFader(gain) * 1000)}
        disabled={disabled}
        onChange={(e) => onChange(faderToGain(Number(e.target.value) / 1000))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onDoubleClick={() => {
          onChange(1);
          onCommit?.();
        }}
        aria-label={title}
      />
      {showDb && <span className="w-14 text-right font-mono text-[10px] text-text-dim tabular-nums">{gainToDb(gain)}</span>}
    </div>
  );
}
