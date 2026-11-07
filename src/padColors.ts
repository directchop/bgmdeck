import type { PadColor } from "./store/types";

export const PAD_COLOR_HEX: Record<PadColor, string> = {
  amber: "#ff9f1c",
  red: "#ef5350",
  pink: "#ec407a",
  purple: "#ab47bc",
  blue: "#42a5f5",
  teal: "#26a69a",
  green: "#66bb6a",
  lime: "#c0ca33",
  slate: "#78909c",
};

export const padColorHex = (c: PadColor | null | undefined, fallback = "#ff9f1c") => (c ? PAD_COLOR_HEX[c] : fallback);
