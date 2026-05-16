// AI-edit integration harness. Not part of the unit suite — guarded by
// AIEDIT_HARNESS=1 so `npm run perf:gate` skips it. Run explicitly with:
//   AIEDIT_HARNESS=1 npx vitest run src/aiEditHarness.spec.ts
//
// It drives the REAL chat backend with a REAL 7-min transcript, captures
// the apply_eal program the model returns, compiles+executes it through
// the REAL EAL pipeline, and asserts the resulting timeline makes sense
// for each natural-language editing prompt.
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  createInitialProject,
  projectReducer,
  idleJobStatus,
  type ProjectAsset,
  type ProjectPresent,
} from './projectModel';
import { createEditArrayFromRuntime } from './editArrayLanguage';
import { compileEditArrayProgram } from './editCompiler';
import { executeEditPlan } from './editRuntime';
import { PROJECT_PRESETS } from './projectPersistence';

const TRANSCRIPT_PATH = '/tmp/aiedit-harness/transcript.json';
const BACKEND = 'http://127.0.0.1:8787';
const ENABLED = process.env.AIEDIT_HARNESS === '1' && existsSync(TRANSCRIPT_PATH);

type Word = { start: number; end: number; word: string };
type Seg = { start: number; end: number; text: string };

const FILLER_WORDS = new Set([
  'um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'ahh', 'eh',
  'hmm', 'hm', 'mhm', 'mm', 'mmm',
]);
const normalizeWord = (w: string) => w.toLowerCase().replace(/[^a-z']/g, '');

// EXACT replica of App.tsx formatExcerpt (kept in sync deliberately — the
// harness must feed the model the same context the app does).
function formatExcerpt(t: { segments: Seg[]; words: Word[]; text: string }, clip: { sourceIn: number; sourceOut: number }): string {
  const segments = t.segments
    .filter((s) => s.end >= clip.sourceIn - 0.25 && s.start <= clip.sourceOut + 0.25)
    .map((s) => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text.trim()}`);
  const readable = segments.length === 0 ? t.text : segments.join('\n');
  const words = t.words.filter((w) => w.end >= clip.sourceIn - 0.25 && w.start <= clip.sourceOut + 0.25);
  if (words.length === 0) return readable;
  const removable: string[] = [];
  const leadIn = words[0].start - clip.sourceIn;
  if (leadIn > 0.4) removable.push(`silence ${clip.sourceIn.toFixed(2)}-${words[0].start.toFixed(2)} (${leadIn.toFixed(2)}s lead-in)`);
  for (let i = 0; i < words.length - 1; i += 1) {
    const gap = words[i + 1].start - words[i].end;
    if (gap > 0.6) removable.push(`silence ${words[i].end.toFixed(2)}-${words[i + 1].start.toFixed(2)} (${gap.toFixed(2)}s pause)`);
  }
  const lastEnd = words[words.length - 1].end;
  const tail = clip.sourceOut - lastEnd;
  if (tail > 0.4) removable.push(`silence ${lastEnd.toFixed(2)}-${clip.sourceOut.toFixed(2)} (${tail.toFixed(2)}s trailing)`);
  for (let i = 0; i < words.length; i += 1) {
    const norm = normalizeWord(words[i].word);
    if (!norm) continue;
    if (FILLER_WORDS.has(norm)) removable.push(`filler "${words[i].word.trim()}" ${words[i].start.toFixed(2)}-${words[i].end.toFixed(2)}`);
    else if (i > 0 && norm === normalizeWord(words[i - 1].word) && norm.length > 1) removable.push(`repeat "${words[i].word.trim()}" ${words[i].start.toFixed(2)}-${words[i].end.toFixed(2)}`);
  }
  if (removable.length === 0) return readable;
  return `${readable}\n\n[Removable ranges — source-time seconds, keep everything else]\n${removable.join('\n')}`;
}

function buildProject(durationSeconds: number): { project: ProjectPresent; assetId: string; clipId: string } {
  const asset: ProjectAsset = {
    duration: durationSeconds,
    file: new File(['v'], 'battle-royale.mov', { type: 'video/quicktime' }),
    height: 1080,
    id: 'asset-vid',
    kind: 'video',
    name: 'battle-royale.mov',
    originalUrl: 'blob:vid',
    playbackUrl: 'blob:vid',
    posterUrl: null,
    proxyStatus: idleJobStatus,
    proxyUrl: null,
    size: 1024,
    type: 'video/quicktime',
    width: 1920,
  };
  let project = createInitialProject();
  project = projectReducer(project, { assets: [asset], type: 'ADD_ASSETS' });
  project = projectReducer(project, { assetId: 'asset-vid', clipId: 'clip-main', timelineStart: 0, type: 'ADD_ASSET_TO_TIMELINE' });
  return { project: project.present, assetId: 'asset-vid', clipId: 'clip-main' };
}

async function askModel(prompt: string, project: ProjectPresent, excerpt: string): Promise<{ program: unknown[] | null; prose: string; raw: string }> {
  const editArray = createEditArrayFromRuntime(project, PROJECT_PRESETS.landscape, 'Battle Royale');
  const body = {
    context: {
      active_clip_id: 'clip-main',
      beats: [],
      edit_array: editArray,
      playhead_seconds: 0,
      project_name: 'Battle Royale',
      selected_clip_id: 'clip-main',
      selected_text_id: null,
      selected_track_id: null,
      transcripts: [{ asset_id: 'asset-vid', clip_id: 'clip-main', excerpt, language: 'en' }],
    },
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  };
  const res = await fetch(`${BACKEND}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`chat failed ${res.status}: ${await res.text().catch(() => '')}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let prose = '';
  let program: unknown[] | null = null;
  const raw: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let b = buf.indexOf('\n\n');
    while (b !== -1) {
      const frame = buf.slice(0, b);
      buf = buf.slice(b + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (!p) continue;
        raw.push(p);
        try {
          const ev = JSON.parse(p);
          if (ev.type === 'delta') prose += ev.text;
          else if (ev.type === 'tool_call' && ev.name === 'apply_eal') {
            program = ev.arguments?.program ?? null;
          } else if (ev.type === 'error') throw new Error(`stream error: ${ev.message}`);
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('stream error')) throw e;
        }
      }
      b = buf.indexOf('\n\n');
    }
  }
  return { program, prose, raw: raw.join('\n') };
}

function runEal(program: unknown[], project: ProjectPresent) {
  const plan = compileEditArrayProgram(program);
  const result = executeEditPlan(plan, project);
  const errors = [...plan.diagnostics, ...result.diagnostics].filter((d) => d.severity === 'error');
  const clips = [...result.project.clips].sort((a, b) => a.timelineStart - b.timelineStart);
  const totalTimeline = clips.reduce((m, c) => Math.max(m, c.timelineStart + (c.sourceOut - c.sourceIn)), 0);
  const totalSource = clips.reduce((s, c) => s + (c.sourceOut - c.sourceIn), 0);
  return { plan, result, errors, clips, totalTimeline, totalSource };
}

describe.skipIf(!ENABLED)('AI edit harness — 7-min battle royale clip', () => {
  let transcript: { segments: Seg[]; words: Word[]; text: string; duration: number };
  let excerpt: string;
  let base: ReturnType<typeof buildProject>;

  beforeAll(() => {
    transcript = JSON.parse(readFileSync(TRANSCRIPT_PATH, 'utf8'));
    base = buildProject(transcript.duration);
    const clip = base.project.clips[0];
    excerpt = formatExcerpt(transcript, clip);
  });

  const cases: Array<{ name: string; prompt: string; assert: (r: ReturnType<typeof runEal>, srcDur: number) => void }> = [
    {
      name: 'remove filler words',
      prompt: 'remove all the filler words (um, uh, etc.) and close the gaps',
      assert: (r, d) => { expect(r.errors).toEqual([]); expect(r.clips.length).toBeGreaterThan(1); expect(r.totalSource).toBeLessThan(d); },
    },
    {
      name: 'remove silence / dead air',
      prompt: 'remove all the silence and dead air, tighten the whole thing',
      assert: (r, d) => { expect(r.errors).toEqual([]); expect(r.clips.length).toBeGreaterThan(1); expect(r.totalSource).toBeLessThan(d * 0.95); },
    },
    {
      name: 'remove repeated takes',
      prompt: 'remove repeated words and repeated takes',
      assert: (r) => { expect(r.errors).toEqual([]); expect(r.clips.length).toBeGreaterThanOrEqual(1); },
    },
    {
      name: 'prepare for production (filler+silence+repeats)',
      prompt: 'apply cuts and remove the filler, repeats and dead air, prepare this clip for production',
      assert: (r, d) => { expect(r.errors).toEqual([]); expect(r.clips.length).toBeGreaterThan(2); expect(r.totalSource).toBeLessThan(d * 0.95); expect(r.totalSource).toBeGreaterThan(d * 0.3); },
    },
    {
      name: 'make this more fast-paced',
      prompt: 'make this more fast-paced',
      assert: (r, d) => { expect(r.errors).toEqual([]); expect(r.totalSource).toBeLessThan(d); },
    },
    {
      name: 'best 30-60s reel',
      prompt: 'make a punchy 30 to 60 second reel from the best moments of this video',
      assert: (r) => { expect(r.errors).toEqual([]); expect(r.totalTimeline).toBeGreaterThan(15); expect(r.totalTimeline).toBeLessThan(90); },
    },
    {
      name: 'cut into best 5 shorts',
      prompt: 'cut this into the best 5 shorts',
      assert: (r) => { expect(r.errors).toEqual([]); expect(r.clips.length).toBeGreaterThanOrEqual(2); },
    },
    {
      name: 'keep only high-value sections',
      prompt: 'keep only the high-value, high-retention sections and drop the boring parts',
      assert: (r, d) => { expect(r.errors).toEqual([]); expect(r.totalSource).toBeLessThan(d); expect(r.clips.length).toBeGreaterThanOrEqual(1); },
    },
    {
      name: 'only keep parts about a topic',
      prompt: 'only keep the parts about France and Germany, cut everything else',
      assert: (r, d) => { expect(r.errors).toEqual([]); expect(r.totalSource).toBeLessThan(d); },
    },
  ];

  for (const c of cases) {
    // 300 s: deepseek-v4-flash reasoning + emitting a 40-60 clip EAL
    // program is the slow path; 180 s killed the wrapper before a
    // logic-correct result resolved.
    it(`${c.name}`, { timeout: 300_000 }, async () => {
      const { project } = buildProject(transcript.duration);
      const { program, prose, raw } = await askModel(c.prompt, project, excerpt);
      if (!program) {
        throw new Error(`No apply_eal returned for "${c.prompt}".\nProse: ${prose.slice(0, 400)}\nRaw tail: ${raw.slice(-400)}`);
      }
      const r = runEal(program, project);
      if (r.errors.length) {
        throw new Error(`EAL errors for "${c.prompt}": ${JSON.stringify(r.errors)}\nclips=${r.clips.length} prog=${JSON.stringify(program).slice(0, 600)}`);
      }
      c.assert(r, transcript.duration);
      // eslint-disable-next-line no-console
      console.log(`✓ ${c.name}: ${r.clips.length} clips, timeline≈${r.totalTimeline.toFixed(1)}s, source≈${r.totalSource.toFixed(1)}s (orig ${transcript.duration.toFixed(0)}s)`);
    });
  }
});
