import { describe, expect, it } from 'vitest';
import { cssAnchor, ffmpegDrawtextAnchor, resolveExpectedPixel, type TextAlign } from './textPositioning';

// The CSS anchor relies on the browser to resolve `translate(...)`; we can't
// run the layout engine here, but we can verify the math we INTEND. For a
// CSS rule `left: x%; top: y%; transform: translate(-Tx, -50%)`, the visible
// text box's top-left is at:
//   px = x * W - Tx * text_w
//   py = y * H - 0.5 * text_h
// where Tx is 0.5 for center, 1.0 for right, 0.0 for left.
function cssExpectedPixel(
  align: TextAlign,
  x: number,
  y: number,
  frame: { width: number; height: number },
  textBox: { width: number; height: number },
): { x: number; y: number } {
  const tx = align === 'center' ? 0.5 : align === 'right' ? 1.0 : 0.0;
  return {
    x: x * frame.width - tx * textBox.width,
    y: y * frame.height - 0.5 * textBox.height,
  };
}

// Substitute the symbolic FFmpeg drawtext expressions to a real pixel value.
function evalDrawtextExpression(
  expr: string,
  frame: { width: number; height: number },
  textBox: { width: number; height: number },
): number {
  const replaced = expr
    .replace(/text_w/g, String(textBox.width))
    .replace(/text_h/g, String(textBox.height))
    .replace(/\bw\b/g, String(frame.width))
    .replace(/\bh\b/g, String(frame.height));
  // The expressions we emit are always `<scalar>*<num>±<term>/<num>?` so eval
  // is fine here — limited grammar, never user-supplied.
  // eslint-disable-next-line no-new-func
  return Function(`return (${replaced})`)();
}

describe('text positioning (preview ↔ export parity)', () => {
  // Three aspect ratios cover the main outputs.
  const frames = [
    { height: 1080, label: '16:9 landscape', width: 1920 },
    { height: 1920, label: '9:16 vertical', width: 1080 },
    { height: 1080, label: '1:1 square', width: 1080 },
  ];

  const textBox = { height: 120, width: 380 };

  for (const frame of frames) {
    for (const align of ['left', 'center', 'right'] as const) {
      for (const [x, y] of [
        [0.5, 0.5],
        [0.2, 0.85],
        [0.85, 0.2],
        [0.05, 0.95],
      ] as const) {
        it(`agrees for ${frame.label} / align=${align} / (${x}, ${y})`, () => {
          const css = cssExpectedPixel(align, x, y, frame, textBox);
          const ff = ffmpegDrawtextAnchor({ align, x, y });
          const ffPx = {
            x: evalDrawtextExpression(ff.x, frame, textBox),
            y: evalDrawtextExpression(ff.y, frame, textBox),
          };
          // Same point within sub-pixel tolerance.
          expect(ffPx.x).toBeCloseTo(css.x, 3);
          expect(ffPx.y).toBeCloseTo(css.y, 3);
          // resolveExpectedPixel matches both other paths — it's the shared
          // "what should the actual pixel be" reference.
          const ref = resolveExpectedPixel({ align, x, y }, frame, textBox);
          expect(ref.x).toBeCloseTo(css.x, 3);
          expect(ref.y).toBeCloseTo(css.y, 3);
        });
      }
    }
  }

  it('cssAnchor returns transforms the browser can apply directly', () => {
    expect(cssAnchor({ align: 'left', x: 0.5, y: 0.5 }).transform).toBe('translateY(-50%)');
    expect(cssAnchor({ align: 'center', x: 0.5, y: 0.5 }).transform).toBe('translate(-50%, -50%)');
    expect(cssAnchor({ align: 'right', x: 0.5, y: 0.5 }).transform).toBe('translate(-100%, -50%)');
    // % formatting is preserved.
    expect(cssAnchor({ align: 'center', x: 0.25, y: 0.85 }).left).toBe('25.000%');
    expect(cssAnchor({ align: 'center', x: 0.25, y: 0.85 }).top).toBe('85.000%');
  });
});
