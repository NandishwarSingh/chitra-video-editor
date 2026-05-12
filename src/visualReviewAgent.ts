import type { EditArrayIr } from './editArrayIr';
import type { ProjectSettings } from './projectPersistence';

export type VisualReviewIssue = {
  code: string;
  message: string;
  severity: 'blocker' | 'info' | 'warning';
  targetId?: string;
};

export type VisualReviewReport = {
  issues: VisualReviewIssue[];
  summary: {
    assets: number;
    clips: number;
    duration: number;
    reservedOperations: number;
    textOverlays: number;
  };
};

export type VisualReviewAgent = (ir: EditArrayIr, settings: ProjectSettings) => Promise<VisualReviewReport> | VisualReviewReport;

export function createVisualReviewReport(ir: EditArrayIr, settings: ProjectSettings): VisualReviewReport {
  const issues: VisualReviewIssue[] = [];
  const timelineDuration = ir.clips.reduce((total, clip) => total + Math.max(0.1, clip.sourceOut - clip.sourceIn), 0);

  if (ir.assets.length === 0) {
    issues.push({ code: 'no_assets', message: 'No media assets are available.', severity: 'blocker' });
  }

  if (ir.clips.length === 0) {
    issues.push({ code: 'empty_timeline', message: 'The timeline has no clips.', severity: 'blocker' });
  }

  ir.diagnostics.forEach((diagnostic) => {
    issues.push({
      code: diagnostic.code,
      message: diagnostic.message,
      severity: diagnostic.severity === 'error' ? 'blocker' : 'warning',
    });
  });

  ir.clips.forEach((clip) => {
    const clipDuration = Math.max(0.1, clip.sourceOut - clip.sourceIn);

    if (clipDuration < 0.25) {
      issues.push({
        code: 'flash_clip',
        message: `Clip "${clip.id}" is shorter than 250ms.`,
        severity: 'warning',
        targetId: clip.id,
      });
    }

    if (Math.abs(clip.effects.brightness) > 0.3 || clip.effects.contrast > 1.6 || clip.effects.saturation > 1.8) {
      issues.push({
        code: 'effect_overdrive',
        message: `Clip "${clip.id}" has aggressive color settings.`,
        severity: 'warning',
        targetId: clip.id,
      });
    }

    if (clip.transform.scale > 3 || clip.transform.x < 0.05 || clip.transform.x > 0.95 || clip.transform.y < 0.05 || clip.transform.y > 0.95) {
      issues.push({
        code: 'clip_transform_edge',
        message: `Clip "${clip.id}" transform may crop important content.`,
        severity: 'warning',
        targetId: clip.id,
      });
    }
  });

  ir.textOverlays.forEach((overlay) => {
    if (overlay.x < 0.08 || overlay.x > 0.92 || overlay.y < 0.08 || overlay.y > 0.92) {
      issues.push({
        code: 'text_near_edge',
        message: `Text "${overlay.id}" is too close to the canvas edge.`,
        severity: 'warning',
        targetId: overlay.id,
      });
    }

    if (overlay.text.length > 72) {
      issues.push({
        code: 'text_too_long',
        message: `Text "${overlay.id}" is long for a single overlay.`,
        severity: 'warning',
        targetId: overlay.id,
      });
    }
  });

  if (settings.width <= 0 || settings.height <= 0) {
    issues.push({ code: 'invalid_export_size', message: 'Export dimensions are invalid.', severity: 'blocker' });
  }

  return {
    issues,
    summary: {
      assets: ir.assets.length,
      clips: ir.clips.length,
      duration: Number(timelineDuration.toFixed(3)),
      reservedOperations: ir.reservedOperations.length,
      textOverlays: ir.textOverlays.length,
    },
  };
}

export function createOpenRouterVisualReviewAgent(endpoint = '/api/openrouter/visual-review'): VisualReviewAgent {
  return async (ir, settings) => {
    const response = await fetch(endpoint, {
      body: JSON.stringify({ ir, settings }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(`OpenRouter visual review backend failed with ${response.status}.`);
    }

    return (await response.json()) as VisualReviewReport;
  };
}

export type WhisperTranscriptSegment = {
  end: number;
  start: number;
  text: string;
};

export async function transcribeWithWhisperCppBackend(file: File, endpoint = '/api/whisper/transcribe') {
  const body = new FormData();
  body.append('media', file);

  const response = await fetch(endpoint, {
    body,
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`whisper.cpp backend failed with ${response.status}.`);
  }

  return (await response.json()) as { segments: WhisperTranscriptSegment[]; text: string };
}
