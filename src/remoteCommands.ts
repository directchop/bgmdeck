// Commands a remote (OSC / MIDI) can issue. Pure data so the mappers are
// unit-testable; `executeRemote` applies one to the store.
import { useDeckStore } from "./store/deck";

export type RemoteCommand =
  | { type: "play"; pad: number; bank?: number; fade?: number }
  | { type: "stop"; fade?: number }
  | { type: "stopNow" }
  | { type: "bank"; index: number }
  | { type: "bankNext" }
  | { type: "bankPrev" }
  | { type: "master"; value: number }
  | { type: "padVolume"; pad: number; value: number }
  | { type: "duck"; on: boolean | "toggle" }
  | { type: "ping" };

export function executeRemote(cmd: RemoteCommand): void {
  const s = useDeckStore.getState();
  switch (cmd.type) {
    case "play": {
      // Remote play always (re)starts: a controller is not a toggle.
      const bank = cmd.bank === undefined ? s.banks.find((b) => b.id === s.currentBankId) : s.banks[cmd.bank];
      const slot = bank?.slots[cmd.pad];
      if (!slot || !bank) return;
      if (bank.id !== s.currentBankId) s.selectBank(bank.id);
      void s.play(slot.id, { restart: true });
      return;
    }
    case "stop":
      void s.stop(cmd.fade);
      return;
    case "stopNow":
      void s.stopNow();
      return;
    case "bank":
      s.selectBankIndex(cmd.index);
      return;
    case "bankNext":
      s.nextBank();
      return;
    case "bankPrev":
      s.prevBank();
      return;
    case "master":
      s.setMaster(cmd.value);
      return;
    case "padVolume": {
      const bank = s.banks.find((b) => b.id === s.currentBankId);
      const slot = bank?.slots[cmd.pad];
      if (slot) s.setSlotVolume(slot.id, cmd.value, false);
      return;
    }
    case "duck":
      if (cmd.on === "toggle") s.toggleDuck();
      else s.setDuck(cmd.on);
      return;
    case "ping":
      return;
  }
}
