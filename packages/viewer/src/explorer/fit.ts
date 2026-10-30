/** Room kept clear around the fitted diagram for the overlays: zoom on top, minimap below. */
export const FIT_INSET = { x: 24, y: 64 } as const;

/**
 * The zoom that fits the diagram in the canvas with {@link FIT_INSET} clear
 * (never above 100%, never below 40%), rounded down to a hundredth. An
 * unmeasured canvas (0 × 0, as in tests) gets 100%. The explorer fits each
 * level until pan and zoom arrive (M4b.4).
 */
export function fitScale(
  diagram: { width: number; height: number },
  canvas: { width: number; height: number },
): number {
  if (canvas.width <= 0 || canvas.height <= 0) return 1;
  const sx = (canvas.width - 2 * FIT_INSET.x) / Math.max(diagram.width, 1);
  const sy = (canvas.height - 2 * FIT_INSET.y) / Math.max(diagram.height, 1);
  return Math.max(0.4, Math.min(1, Math.floor(Math.min(sx, sy) * 100) / 100));
}
