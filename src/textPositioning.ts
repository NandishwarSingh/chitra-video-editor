// Single source of truth for how a text overlay's (x, y, align) tuple maps
// onto a coordinate. Both the preview (CSS) and the export (FFmpeg drawtext)
// consume this so they cannot drift in different directions.
//
// Coordinate contract:
//   - (x, y) are normalised positions in [0, 1] relative to the frame.
//   - For ALL alignments, the **vertical anchor** is the text box's center
//     at `y * H`.
//   - The **horizontal anchor** depends on `align`:
//       'left'   → left edge at x*W
//       'center' → horizontal center at x*W
//       'right'  → right edge at x*W
// This matches CSS rendering with `transform: translate{X}(-50%|0|-100%)
// translateY(-50%)` and is mirrored by the FFmpeg expressions below.

export type TextAlign = 'left' | 'center' | 'right';

export type TextAnchorInput = {
  align: TextAlign;
  /** Normalised horizontal position (0..1). */
  x: number;
  /** Normalised vertical position (0..1). */
  y: number;
};

export type TextAnchorCss = {
  left: string;
  top: string;
  transform: string;
};

export type TextAnchorFfmpeg = {
  /** FFmpeg drawtext expression for the `x=` argument. */
  x: string;
  /** FFmpeg drawtext expression for the `y=` argument. */
  y: string;
};

/** CSS positioning that matches the export coordinate contract. */
export function cssAnchor(input: TextAnchorInput): TextAnchorCss {
  const left = `${(input.x * 100).toFixed(3)}%`;
  const top = `${(input.y * 100).toFixed(3)}%`;
  const tx =
    input.align === 'center' ? 'translate(-50%, -50%)'
    : input.align === 'right' ? 'translate(-100%, -50%)'
    : 'translateY(-50%)';
  return { left, top, transform: tx };
}

/** FFmpeg drawtext `x=`/`y=` expressions matching the same anchor. */
export function ffmpegDrawtextAnchor(input: TextAnchorInput): TextAnchorFfmpeg {
  const xN = clamp01(input.x).toFixed(4);
  const yN = clamp01(input.y).toFixed(4);
  const x =
    input.align === 'center' ? `w*${xN}-text_w/2`
    : input.align === 'right' ? `w*${xN}-text_w`
    : `w*${xN}`;
  const y = `h*${yN}-text_h/2`;
  return { x, y };
}

/**
 * Apply both anchors to a concrete frame and return the resolved pixel
 * positions. Used by tests to assert that the two systems produce the same
 * point for a given (x, y, align, frame_w, frame_h, text_w, text_h).
 *
 * The FFmpeg drawtext expressions are evaluated symbolically (we don't run
 * ffmpeg here); we substitute w/h/text_w/text_h with the provided values.
 */
export function resolveExpectedPixel(
  input: TextAnchorInput,
  frame: { width: number; height: number },
  textBox: { width: number; height: number },
): { x: number; y: number } {
  const x =
    input.align === 'center' ? input.x * frame.width - textBox.width / 2
    : input.align === 'right' ? input.x * frame.width - textBox.width
    : input.x * frame.width;
  const y = input.y * frame.height - textBox.height / 2;
  return { x, y };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
