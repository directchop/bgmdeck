import { useEffect, useState } from "react";
import { subscribeDragOver } from "../dropFiles";
import { subscribePadDragOver } from "../padDrag";
import { useDeckStore } from "../store/deck";
import { useUiStore } from "../uiStore";
import { Pad } from "./Pad";

export function PadGrid() {
  const banks = useDeckStore((s) => s.banks);
  const currentBankId = useDeckStore((s) => s.currentBankId);
  const voices = useDeckStore((s) => s.voices);
  const selectedSlotId = useDeckStore((s) => s.selectedSlotId);
  const selectSlot = useDeckStore((s) => s.selectSlot);
  const showWaveforms = useUiStore((s) => s.showWaveforms);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [swapOver, setSwapOver] = useState<string | null>(null);
  useEffect(() => subscribeDragOver(setDragOver), []);
  useEffect(() => subscribePadDragOver(setSwapOver), []);

  const bank = banks.find((b) => b.id === currentBankId) ?? banks[0];
  if (!bank) return null;

  return (
    <div
      className="flex-1 min-h-0 overflow-auto p-3"
      onClick={(e) => {
        if (e.target === e.currentTarget) selectSlot(null);
      }}
    >
      <div className="grid gap-3 h-full" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gridTemplateRows: "repeat(2, minmax(120px, 1fr))" }}>
        {bank.slots.map((slot, i) => {
          const voice = voices.filter((v) => v.slotId === slot.id).sort((a, b) => b.gen - a.gen)[0] ?? null;
          return (
            <Pad
              key={slot.id}
              slot={slot}
              index={i}
              voice={voice}
              selected={selectedSlotId === slot.id}
              dragOver={dragOver === slot.id || swapOver === slot.id}
              showWaveform={showWaveforms}
            />
          );
        })}
      </div>
    </div>
  );
}
