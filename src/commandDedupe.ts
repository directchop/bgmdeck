// A shortcut can reach the app twice: once as a webview keydown and once as
// the native menu accelerator for the same command. Which arrives first, or
// whether both arrive at all, depends on the platform (WKWebView lets the
// page preventDefault the key equivalent; Win32 translates accelerators in
// the host loop). Pair each arrival with an opposite-source arrival inside a
// short window and run only the first of the pair. Repeats of the same source
// (holding Ctrl+Z) are never paired with each other, so key repeat still
// undoes once per keystroke.

export type CommandSource = "key" | "menu";

interface Arrival {
  source: CommandSource;
  at: number;
}

export class CommandDeduper {
  private pending = new Map<string, Arrival[]>();

  constructor(
    private readonly windowMs = 400,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** True when the caller should run the command, false when this arrival is
   *  the echo of one that already ran. */
  accept(id: string, source: CommandSource): boolean {
    const t = this.now();
    const list = (this.pending.get(id) ?? []).filter((a) => t - a.at < this.windowMs);
    const twin = list.findIndex((a) => a.source !== source);
    if (twin >= 0) {
      list.splice(twin, 1);
      this.store(id, list);
      return false;
    }
    list.push({ source, at: t });
    this.store(id, list);
    return true;
  }

  private store(id: string, list: Arrival[]) {
    if (list.length === 0) this.pending.delete(id);
    else this.pending.set(id, list);
  }
}
