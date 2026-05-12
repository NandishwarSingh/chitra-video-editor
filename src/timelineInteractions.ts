export function isClipReorderDrag(startX: number, startY: number, currentX: number, currentY: number, thresholdPx = 6) {
  return Math.hypot(currentX - startX, currentY - startY) >= thresholdPx;
}
