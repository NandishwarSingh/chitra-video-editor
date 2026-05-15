// Subtitle cue generation + template registry.
//
// Templates are partial TextOverlay styles you can apply to one cue, a
// selection, or the whole cue group. Generation reads transcript words /
// segments and emits TextOverlay records ready to splice into the timeline.
//
// The data shape is deliberately a *subset* of TextOverlay so each cue
// round-trips through EAL with no schema changes — the existing TextOverlay
// fields already cover everything a subtitle needs (text, start, end, x, y,
// align, size, color, backgroundColor, strokeColor, strokeWidth,
// shadow*, bold, italic, underline, lineHeight, letterSpacing, textCase,
// fontFamily, opacity, rotation, skewX, skewY).

import type { StoredAssetTranscript, StoredTranscriptSegment, StoredTranscriptWord } from './projectStore';
import { DEFAULT_TEXT_OVERLAY, type TextOverlay, type TimelineClip } from './projectModel';

export type SubtitleMode = 'sentence' | 'phrase' | 'word';

export type SubtitleTemplateId =
  | 'clean-lower-third'
  | 'bold-social'
  | 'karaoke-highlight'
  | 'documentary'
  | 'minimal-white'
  | 'boxed-caption';

export type SubtitleTemplate = {
  description: string;
  id: SubtitleTemplateId;
  label: string;
  /** Style fields applied on top of the cue's text + timing. Anything not
   *  set here inherits from DEFAULT_TEXT_OVERLAY so templates stay diff-able. */
  style: Partial<TextOverlay>;
};

// Templates are tuned to look right on a 1080p output. Sizes are absolute
// pixels at the project's output resolution, NOT viewer pixels.
export const SUBTITLE_TEMPLATES: ReadonlyArray<SubtitleTemplate> = [
  {
    description: 'Modern channel-style caption with a translucent slate plate.',
    id: 'clean-lower-third',
    label: 'Clean lower-third',
    style: {
      align: 'center',
      backgroundColor: '#000000b3',
      bold: true,
      color: '#ffffff',
      fontFamily: 'inter',
      lineHeight: 1.2,
      shadowBlur: 6,
      shadowColor: '#000000b3',
      shadowOffsetX: 0,
      shadowOffsetY: 2,
      size: 54,
      strokeColor: '#000000',
      strokeWidth: 0,
      x: 0.5,
      y: 0.85,
    },
  },
  {
    description: 'Big, punchy social-media caption with a heavy outline.',
    id: 'bold-social',
    label: 'Bold social caption',
    style: {
      align: 'center',
      backgroundColor: '#00000000',
      bold: true,
      color: '#ffffff',
      fontFamily: 'bebas',
      lineHeight: 1.05,
      shadowBlur: 0,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      size: 96,
      strokeColor: '#000000',
      strokeWidth: 6,
      textCase: 'upper',
      x: 0.5,
      y: 0.78,
    },
  },
  {
    description: 'Word-by-word highlight; pair with mode = "word" for karaoke.',
    id: 'karaoke-highlight',
    label: 'Karaoke highlight',
    style: {
      align: 'center',
      backgroundColor: '#000000d9',
      bold: true,
      color: '#f5cb47',
      fontFamily: 'inter',
      lineHeight: 1.15,
      shadowBlur: 6,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      size: 72,
      strokeColor: '#000000',
      strokeWidth: 3,
      x: 0.5,
      y: 0.86,
    },
  },
  {
    description: 'Quiet documentary-style serif at the bottom of frame.',
    id: 'documentary',
    label: 'Documentary',
    style: {
      align: 'center',
      backgroundColor: '#00000000',
      bold: false,
      color: '#ffffff',
      fontFamily: 'serif',
      italic: true,
      lineHeight: 1.3,
      shadowBlur: 8,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 1,
      size: 46,
      strokeColor: '#000000',
      strokeWidth: 0,
      x: 0.5,
      y: 0.88,
    },
  },
  {
    description: 'No-frills white text, no plate. Good for clean B-roll.',
    id: 'minimal-white',
    label: 'Minimal white',
    style: {
      align: 'center',
      backgroundColor: '#00000000',
      bold: true,
      color: '#ffffff',
      fontFamily: 'inter',
      lineHeight: 1.2,
      shadowBlur: 6,
      shadowColor: '#000000a8',
      shadowOffsetX: 0,
      shadowOffsetY: 2,
      size: 56,
      strokeColor: '#000000',
      strokeWidth: 0,
      x: 0.5,
      y: 0.87,
    },
  },
  {
    description: 'Boxed caption with a solid plate — high readability over busy footage.',
    id: 'boxed-caption',
    label: 'Boxed caption',
    style: {
      align: 'center',
      backgroundColor: '#000000ee',
      bold: true,
      color: '#ffffff',
      fontFamily: 'inter',
      lineHeight: 1.25,
      shadowBlur: 0,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      size: 52,
      strokeColor: '#000000',
      strokeWidth: 0,
      x: 0.5,
      y: 0.85,
    },
  },
];

export function findSubtitleTemplate(id: SubtitleTemplateId): SubtitleTemplate {
  return SUBTITLE_TEMPLATES.find((t) => t.id === id) ?? SUBTITLE_TEMPLATES[0];
}

export type SubtitleGenerationOptions = {
  /** Cue granularity. */
  mode: SubtitleMode;
  /** Template applied to every generated cue. */
  template: SubtitleTemplate;
  /** Target text track id. */
  trackId: string;
  /** Max chars before splitting into a new cue (phrase / word modes). */
  maxCharsPerCue?: number;
  /** Hard lower bound on cue duration so very short words don't flash. */
  minCueDuration?: number;
  /** Hard upper bound on cue duration so a long pause doesn't strand a cue. */
  maxCueDuration?: number;
  /** Inter-cue padding so adjacent cues don't share a frame. */
  gap?: number;
  /** Factory for unique cue IDs. */
  createId: () => string;
};

/**
 * Convert a transcript into TextOverlay subtitles aligned to the clip's
 * timeline range. Timing is sourced from real word/segment timestamps —
 * we never invent times. When `mode === 'word'` falls back to segment-level
 * if `transcript.words` is empty.
 */
export function generateSubtitleCues(
  transcript: StoredAssetTranscript,
  clip: TimelineClip,
  options: SubtitleGenerationOptions,
): TextOverlay[] {
  // "Accurate" timing rules. Sentence and phrase cues carry whatever
  // transcript times whisper produced — no minimum-duration stretching that
  // could push the cue's `end` past the actual spoken boundary. Word mode is
  // the only one with a small floor (≈ 0.18 s, one karaoke beat) since raw
  // word durations can be 50 ms and would otherwise flash unreadably.
  const minDur =
    options.minCueDuration !== undefined
      ? options.minCueDuration
      : options.mode === 'word' ? 0.18 : 0;
  const maxDur = options.maxCueDuration ?? 6.0;
  // No artificial gap between adjacent cues. If two cues happen to share a
  // boundary that's fine — the editor's overlap-prevention rule treats
  // touching ranges as non-colliding. A non-zero gap delays every cue after
  // the first by `gap` seconds, which is exactly the "off" timing the user
  // reported.
  const gap = options.gap ?? 0;
  const maxChars = options.maxCharsPerCue ?? (options.mode === 'word' ? 24 : options.mode === 'phrase' ? 42 : 84);

  const clipDuration = Math.max(0, clip.sourceOut - clip.sourceIn);
  const project = (sourceSeconds: number) => clip.timelineStart + (sourceSeconds - clip.sourceIn);
  const clipTimelineEnd = clip.timelineStart + clipDuration;

  let pieces: CuePiece[] = [];

  switch (options.mode) {
    case 'word': {
      pieces = transcript.words && transcript.words.length > 0
        ? splitByWord(transcript.words, maxChars, minDur)
        : splitFromSegments(transcript.segments, maxChars);
      break;
    }
    case 'phrase': {
      pieces = transcript.words && transcript.words.length > 0
        ? splitByPhrase(transcript.words, maxChars)
        : splitFromSegments(transcript.segments, maxChars);
      break;
    }
    case 'sentence':
    default: {
      pieces = splitBySentence(transcript.segments, transcript.words ?? [], maxChars);
      break;
    }
  }

  // Pass 1: ensure no piece overlaps the next in source-time. Trim the
  // FIRST piece's end down to the next piece's start instead of pushing the
  // next piece forward — preserves accuracy at the user-visible cue starts.
  for (let i = 0; i < pieces.length - 1; i += 1) {
    if (pieces[i].end > pieces[i + 1].start) {
      pieces[i].end = pieces[i + 1].start;
    }
  }

  const cues: TextOverlay[] = [];
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];
    if (!piece.text.trim()) continue;

    // Clamp to the clip's source range.
    const startSource = Math.max(clip.sourceIn, piece.start);
    let endSource = Math.min(clip.sourceOut, piece.end);
    if (endSource <= startSource) continue;

    // Word-mode floor: extend the END (never the start) to minDur if there's
    // room before the next piece. Sentence / phrase modes default to minDur=0
    // so this branch is a no-op there.
    if (minDur > 0 && endSource - startSource < minDur) {
      const nextStart = i < pieces.length - 1 ? pieces[i + 1].start : clip.sourceOut;
      endSource = Math.min(clip.sourceOut, nextStart, Math.max(endSource, startSource + minDur));
    }

    if (endSource - startSource > maxDur) {
      endSource = startSource + maxDur;
    }

    let startT = project(startSource);
    let endT = project(endSource);
    // Only shift start forward when there is real overlap with a previous
    // cue (transcript inconsistency). Otherwise leave start at the
    // transcript-reported time.
    if (cues.length > 0) {
      const prev = cues[cues.length - 1];
      if (startT < prev.end + gap) {
        startT = prev.end + gap;
      }
    }
    if (endT <= startT) continue;
    if (startT >= clipTimelineEnd) continue;
    endT = Math.min(endT, clipTimelineEnd);

    cues.push({
      ...DEFAULT_TEXT_OVERLAY,
      ...options.template.style,
      end: endT,
      id: options.createId(),
      start: startT,
      text: piece.text.trim(),
      trackId: options.trackId,
    });
  }

  return cues;
}

type CuePiece = { end: number; start: number; text: string };

function splitBySentence(
  segments: StoredTranscriptSegment[],
  words: StoredTranscriptWord[],
  maxChars: number,
): CuePiece[] {
  if (segments.length === 0) return [];
  const out: CuePiece[] = [];
  let buffer: CuePiece | null = null;
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    if (!buffer) {
      buffer = { end: seg.end, start: seg.start, text };
    } else {
      const current: CuePiece = buffer;
      // Try to extend the buffer until we hit sentence-ending punctuation
      // or exceed maxChars.
      const combined: string = `${current.text} ${text}`;
      if (combined.length > maxChars || /[.!?…]$/.test(current.text)) {
        out.push(current);
        buffer = { end: seg.end, start: seg.start, text };
      } else {
        buffer = { end: seg.end, start: current.start, text: combined };
      }
    }
  }
  if (buffer) out.push(buffer);

  // Fine-grain sentence boundaries using word timestamps when available so
  // we don't strand a long segment containing two sentences as one cue.
  if (words.length > 0) {
    return refineSentencesWithWords(out, words, maxChars);
  }
  return out;
}

function refineSentencesWithWords(
  cues: CuePiece[],
  words: StoredTranscriptWord[],
  maxChars: number,
): CuePiece[] {
  const refined: CuePiece[] = [];
  for (const cue of cues) {
    if (cue.text.length <= maxChars) {
      refined.push(cue);
      continue;
    }
    const span = words.filter((w) => w.start >= cue.start - 0.01 && w.end <= cue.end + 0.01);
    if (span.length === 0) {
      refined.push(cue);
      continue;
    }
    // Walk forward gathering words until a sentence-terminator + we have
    // enough content, OR we hit maxChars.
    let buf: StoredTranscriptWord[] = [];
    for (const w of span) {
      buf.push(w);
      const text = buf.map((x) => x.word).join(' ');
      const finished = /[.!?…]$/.test(w.word) && text.length >= maxChars / 2;
      if (finished || text.length >= maxChars) {
        refined.push({ end: buf[buf.length - 1].end, start: buf[0].start, text });
        buf = [];
      }
    }
    if (buf.length > 0) {
      const text = buf.map((x) => x.word).join(' ');
      refined.push({ end: buf[buf.length - 1].end, start: buf[0].start, text });
    }
  }
  return refined;
}

function splitByPhrase(words: StoredTranscriptWord[], maxChars: number): CuePiece[] {
  const out: CuePiece[] = [];
  let buf: StoredTranscriptWord[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.map((w) => w.word).join(' ');
    out.push({ end: buf[buf.length - 1].end, start: buf[0].start, text });
    buf = [];
  };
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    // Flush BEFORE pushing whenever adding this word would exceed the
    // length budget, so no cue ends up over maxChars even on long words.
    if (buf.length > 0) {
      const projected = `${buf.map((x) => x.word).join(' ')} ${w.word}`;
      if (projected.length > maxChars) {
        flush();
      }
    }
    buf.push(w);
    // After pushing, honour sentence-final punctuation or a real silence
    // gap by flushing immediately — both signal a natural cue boundary.
    const next = words[i + 1];
    const naturalBreak = /[,;:.!?…]$/.test(w.word);
    const gap = next ? next.start - w.end : 0;
    const longSilence = gap > 0.45;
    if (naturalBreak || longSilence) {
      flush();
    }
  }
  flush();
  return out;
}

function splitByWord(words: StoredTranscriptWord[], maxChars: number, minDur: number): CuePiece[] {
  // One cue per word, but merge very short words (a/the/I/up) with their
  // neighbour so the timeline isn't peppered with 0.05 s cues.
  const out: CuePiece[] = [];
  for (const w of words) {
    if (!w.word.trim()) continue;
    const piece: CuePiece = { end: w.end, start: w.start, text: w.word };
    const last = out[out.length - 1];
    const tooShort = piece.end - piece.start < minDur * 0.5;
    if (last && tooShort && `${last.text} ${piece.text}`.length <= maxChars) {
      last.text = `${last.text} ${piece.text}`;
      last.end = piece.end;
    } else {
      out.push(piece);
    }
  }
  return out;
}

function splitFromSegments(segments: StoredTranscriptSegment[], maxChars: number): CuePiece[] {
  // Word timestamps missing — fall back to per-segment cues with optional
  // splitting by max-char heuristic (linear time within segment).
  const out: CuePiece[] = [];
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    if (text.length <= maxChars) {
      out.push({ end: seg.end, start: seg.start, text });
      continue;
    }
    const chunks = chunkByChars(text, maxChars);
    const totalChars = chunks.reduce((sum, c) => sum + c.length, 0);
    let cursor = seg.start;
    const segDuration = Math.max(0.1, seg.end - seg.start);
    for (const chunk of chunks) {
      const portion = chunk.length / totalChars;
      const chunkDuration = segDuration * portion;
      const start = cursor;
      const end = Math.min(seg.end, cursor + chunkDuration);
      out.push({ end, start, text: chunk });
      cursor = end;
    }
  }
  return out;
}

function chunkByChars(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out: string[] = [];
  let buf: string[] = [];
  for (const word of words) {
    const projected = buf.length === 0 ? word : `${buf.join(' ')} ${word}`;
    if (projected.length > maxChars && buf.length > 0) {
      out.push(buf.join(' '));
      buf = [word];
    } else {
      buf.push(word);
    }
  }
  if (buf.length > 0) out.push(buf.join(' '));
  return out;
}
