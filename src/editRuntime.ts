import type { CompiledEditPlan } from './editCompiler';
import type { EditArrayDiagnostic, EditArrayIrClip } from './editArrayIr';
import type { ProjectAsset, ProjectPresent, TimelineClip } from './projectModel';

export type EditRuntimeResult = {
  diagnostics: EditArrayDiagnostic[];
  project: ProjectPresent;
};

const CUT_EPSILON = 1e-3;

/**
 * Materialise `cut` IR entries into adjacent timeline clips. Each `cut`
 * references a clip by id and a timeline time `at`; when `at` falls strictly
 * inside the clip's range, the clip is split there. Multiple cuts targeting
 * the same clip produce N+1 adjacent pieces. Cuts outside the clip range
 * (typically the boundary cuts our own emitter produces between adjacent
 * clips) are ignored — they were never splits to begin with.
 *
 * This is the executor honouring an EAL semantic the IR has always carried
 * but the previous runtime silently dropped, which is why AI-emitted beat
 * splits used to leave one un-split clip on the timeline.
 */
function applyCuts(
  irClips: EditArrayIrClip[],
  cuts: Array<{ afterClip: string; at: number }>,
  diagnostics: EditArrayDiagnostic[],
): EditArrayIrClip[] {
  if (cuts.length === 0) return irClips;

  const cutsByClip = new Map<string, number[]>();
  for (const cut of cuts) {
    const bucket = cutsByClip.get(cut.afterClip) ?? [];
    bucket.push(cut.at);
    cutsByClip.set(cut.afterClip, bucket);
  }

  const expanded: EditArrayIrClip[] = [];
  for (const clip of irClips) {
    const requested = cutsByClip.get(clip.id);
    if (!requested || requested.length === 0) {
      expanded.push(clip);
      continue;
    }
    const clipDuration = Math.max(0, clip.sourceOut - clip.sourceIn);
    const clipEnd = clip.timelineStart + clipDuration;

    const valid = Array.from(new Set(requested))
      .filter((t) => t > clip.timelineStart + CUT_EPSILON && t < clipEnd - CUT_EPSILON)
      .sort((a, b) => a - b);

    if (valid.length === 0) {
      expanded.push(clip);
      continue;
    }

    const boundaries = [clip.timelineStart, ...valid, clipEnd];
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const segStart = boundaries[i];
      const segEnd = boundaries[i + 1];
      const localOffsetStart = segStart - clip.timelineStart;
      const localOffsetEnd = segEnd - clip.timelineStart;
      expanded.push({
        ...clip,
        // Preserve the original clip's id on the first piece so existing
        // selection / references in the same program still resolve.
        id: i === 0 ? clip.id : `${clip.id}-${i + 1}`,
        // Drop fades on interior pieces — keep fadeIn on the first piece
        // only and fadeOut on the last piece only so an audio fade-out
        // doesn't get repeated at every cut boundary.
        fadeIn: i === 0 ? clip.fadeIn : 0,
        fadeOut: i === boundaries.length - 2 ? clip.fadeOut : 0,
        sourceIn: clip.sourceIn + localOffsetStart,
        sourceOut: clip.sourceIn + localOffsetEnd,
        timelineStart: segStart,
        timelineEnd: segEnd,
      });
    }
    diagnostics.push({
      code: 'runtime_applied_cuts',
      message: `Split clip "${clip.id}" into ${valid.length + 1} pieces from ${valid.length} cut instruction${valid.length === 1 ? '' : 's'}.`,
      severity: 'info',
    });
  }
  return expanded;
}

export function executeEditPlan(plan: CompiledEditPlan, currentProject: ProjectPresent): EditRuntimeResult {
  const diagnostics: EditArrayDiagnostic[] = [...plan.diagnostics];
  const assetsById = new Map(currentProject.assets.map((asset) => [asset.id, asset]));
  const assets: ProjectAsset[] = [];

  plan.ir.assets.forEach((asset) => {
    const runtimeAsset = assetsById.get(asset.id);

    if (!runtimeAsset) {
      diagnostics.push({
        code: 'runtime_missing_asset',
        message: `Runtime cannot import "${asset.name}" without a matching media file in the library.`,
        severity: 'warning',
      });
      return;
    }

    assets.push(runtimeAsset);
  });

  const validAssetIds = new Set(assets.map((asset) => asset.id));
  const filteredIrClips = plan.ir.clips.filter((clip) => {
    const isValid = validAssetIds.has(clip.assetId);
    if (!isValid) {
      diagnostics.push({
        code: 'runtime_skipped_clip',
        message: `Skipped clip "${clip.id}" because asset "${clip.assetId}" is not available.`,
        severity: 'warning',
      });
    }
    return isValid;
  });

  const materialisedIrClips = applyCuts(filteredIrClips, plan.ir.cuts, diagnostics);

  const clips: TimelineClip[] = materialisedIrClips.map((clip) => ({
    assetId: clip.assetId,
    effects: clip.effects,
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
    id: clip.id,
    muted: clip.muted,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    timelineStart: clip.timelineStart,
    trackId: clip.trackId,
    transform: clip.transform,
    volume: clip.volume,
  }));

  return {
    diagnostics,
    project: {
      assets,
      clips,
      selectedAssetId: assets[0]?.id ?? null,
      selectedClipId: clips[0]?.id ?? null,
      selectedTextId: null,
      selectedTrackId: plan.ir.tracks[0]?.id ?? null,
      textOverlays: plan.ir.textOverlays.map((overlay) => ({
        align: overlay.align,
        backgroundColor: overlay.backgroundColor,
        bold: overlay.bold,
        color: overlay.color,
        end: overlay.end,
        fontFamily: overlay.fontFamily,
        id: overlay.id,
        italic: overlay.italic,
        letterSpacing: overlay.letterSpacing,
        lineHeight: overlay.lineHeight,
        opacity: overlay.opacity,
        rotation: overlay.rotation,
        shadowBlur: overlay.shadowBlur,
        shadowColor: overlay.shadowColor,
        shadowOffsetX: overlay.shadowOffsetX,
        shadowOffsetY: overlay.shadowOffsetY,
        size: overlay.size,
        skewX: overlay.skewX,
        skewY: overlay.skewY,
        start: overlay.start,
        strokeColor: overlay.strokeColor,
        strokeWidth: overlay.strokeWidth,
        text: overlay.text,
        textCase: overlay.textCase,
        trackId: overlay.trackId,
        underline: overlay.underline,
        x: overlay.x,
        y: overlay.y,
      })),
      tracks: plan.ir.tracks,
    },
  };
}
