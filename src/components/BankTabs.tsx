import { useEffect, useRef, useState } from "react";
import { useDeckStore } from "../store/deck";
import { useUiStore } from "../uiStore";

export function BankTabs() {
  const banks = useDeckStore((s) => s.banks);
  const currentBankId = useDeckStore((s) => s.currentBankId);
  const voices = useDeckStore((s) => s.voices);
  const selectBank = useDeckStore((s) => s.selectBank);
  const addBank = useDeckStore((s) => s.addBank);
  const renameBank = useDeckStore((s) => s.renameBank);
  const editing = useUiStore((s) => s.renamingBankId);
  const setEditing = useUiStore((s) => s.setRenamingBankId);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(banks.find((b) => b.id === editing)?.name ?? "");
      setTimeout(() => inputRef.current?.select(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const playingBank = new Set(
    voices.filter((v) => v.stage !== "fadeOut").map((v) => banks.find((b) => b.slots.some((s) => s.id === v.slotId))?.id),
  );

  return (
    <div className="flex items-center gap-1 px-3 h-9 border-b border-border bg-bg-dark overflow-x-auto">
      {banks.map((b, i) => {
        const active = b.id === currentBankId;
        return (
          <div
            key={b.id}
            onClick={() => selectBank(b.id)}
            onDoubleClick={() => setEditing(b.id)}
            title={`${b.name} — [ / ] to switch`}
            className={`group flex items-center gap-1.5 px-3 h-7 rounded-md text-[12px] cursor-pointer select-none whitespace-nowrap ${
              active ? "bg-surface-light text-text" : "text-text-dim hover:text-text hover:bg-surface"
            }`}
          >
            <span className="font-mono text-[10px] text-text-muted">{i + 1}</span>
            {editing === b.id ? (
              <input
                ref={inputRef}
                className="bg-bg-darker border border-border rounded px-1 text-[12px] text-text w-28 outline-none"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  if (draft.trim()) renameBank(b.id, draft.trim());
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <span>{b.name}</span>
            )}
            {playingBank.has(b.id) && <span className="w-1.5 h-1.5 rounded-full bg-green" />}
          </div>
        );
      })}
      <button
        onClick={addBank}
        title="Add bank (Ctrl/⌘+Shift+N)"
        className="ml-1 w-7 h-7 rounded-md text-text-dim hover:text-text hover:bg-surface text-base leading-none"
      >
        +
      </button>
    </div>
  );
}
