import type { ImageSize } from "../models";
import type { SizePx } from "./types";

/** The provider size nearest in aspect to the requested size (square unless clearly not). */
export function providerSizeName(sizePx: SizePx): ImageSize {
  const { width, height } = typeof sizePx === "number" ? { width: sizePx, height: sizePx } : sizePx;
  const aspect = width > 0 && height > 0 ? width / height : 1;
  if (aspect >= 1.25) return "1536x1024";
  if (aspect <= 0.8) return "1024x1536";
  return "1024x1024";
}

export function providerSize(sizePx: SizePx): { name: ImageSize; width: number; height: number } {
  const name = providerSizeName(sizePx);
  const [w, h] = name.split("x").map(Number);
  return { name, width: w ?? 1024, height: h ?? 1024 };
}
