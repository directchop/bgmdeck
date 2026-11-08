// Keyboard shortcuts must win everywhere except inside a text field. This module
// decides what counts as "typing" and keeps focus from sticking to controls that
// would otherwise eat Space (a focused <button> clicks on Space; a focused range
// fader or checkbox swallows it). Space is the panic key: it must always stop and
// never start anything.

const TEXT_INPUT_TYPES = new Set(["text", "search", "number", "password", "email", "url", "tel", ""]);

/** True when `el` is a control that takes typed text (plain keys must go to it). */
export function isTextEntry(el: EventTarget | null): boolean {
  const t = el as (HTMLElement & { type?: string }) | null;
  if (!t || typeof t.tagName !== "string") return false;
  if (t.tagName === "TEXTAREA") return true;
  if (t.tagName === "INPUT") return TEXT_INPUT_TYPES.has((t.type ?? "").toLowerCase());
  return !!t.isContentEditable;
}

/** Elements that must not keep keyboard focus after a mouse / touch click. */
const BLUR_AFTER_CLICK = "button, input[type=range], input[type=checkbox], input[type=radio]";

/** Drop focus from buttons and faders after a pointer click so the next Space
 *  reaches the deck instead of re-clicking the control. Keyboard-initiated clicks
 *  (`detail === 0`) keep focus so Tab navigation still works. */
export function installFocusGuard(): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.detail === 0) return;
    const target = e.target as Element | null;
    const el = target?.closest?.(BLUR_AFTER_CLICK) as HTMLElement | null;
    if (el && document.activeElement === el) el.blur();
  };
  window.addEventListener("click", onClick);
  return () => window.removeEventListener("click", onClick);
}
