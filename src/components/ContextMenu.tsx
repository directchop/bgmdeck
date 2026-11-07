import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuEntry {
  label?: string;
  onSelect?: () => void;
  disabled?: boolean;
  separator?: boolean;
  checked?: boolean;
  swatch?: string;
}

interface Props {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}

export function ContextMenu({ x, y, entries, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 8),
      y: Math.min(y, window.innerHeight - r.height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-[90] min-w-[190px] py-1 bg-surface border border-border-light rounded-md shadow-2xl text-[12px]"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((m, i) =>
        m.separator ? (
          <div key={i} className="my-1 border-t border-border" />
        ) : (
          <button
            key={i}
            disabled={m.disabled}
            onClick={() => {
              m.onSelect?.();
              onClose();
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-text hover:bg-accent/20 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {m.swatch && <span className="w-3 h-3 rounded-sm border border-black/40" style={{ background: m.swatch }} />}
            <span className="flex-1">{m.label}</span>
            {m.checked && <span className="text-accent">✓</span>}
          </button>
        ),
      )}
    </div>
  );
}
