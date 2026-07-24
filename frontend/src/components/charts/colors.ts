/**
 * The chart palette — a validated steel ramp. Industry is a mono scheme, so the three slots
 * encode *magnitude*, not category: deep steel reads first, light steel last. Validated with
 * the dataviz six-checks script against the technical ground (lightness band, chroma floor,
 * CVD ΔE ≥ 8 adjacent, normal-vision floor ≥ 15, contrast ≥ 3:1).
 *
 * Assign shades in this fixed order and never generate more: past three real series the
 * answer is folding into "Other" or a table, not a fourth step.
 */
export const chartColors = {
  /** Slot 1 — deep steel (accent-700). Also the single-hue default for magnitude. */
  primary: '#416180',
  /** Slot 2 — base steel, the accent itself. */
  accent: '#5980a6',
  /** Slot 3 — light steel. (Key name kept from the old palette to avoid call-site churn.) */
  amber: '#93a9c1',
} as const;
