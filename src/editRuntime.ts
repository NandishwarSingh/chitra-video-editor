import type { CompiledEditPlan } from './editCompiler';
import type { EditArrayDiagnostic } from './editArrayIr';
import type { ProjectAsset, ProjectPresent, TimelineClip } from './projectModel';

export type EditRuntimeResult = {
  diagnostics: EditArrayDiagnostic[];
  project: ProjectPresent;
};

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
  const clips: TimelineClip[] = plan.ir.clips
    .filter((clip) => {
      const isValid = validAssetIds.has(clip.assetId);
      if (!isValid) {
        diagnostics.push({
          code: 'runtime_skipped_clip',
          message: `Skipped clip "${clip.id}" because asset "${clip.assetId}" is not available.`,
          severity: 'warning',
        });
      }
      return isValid;
    })
    .map((clip) => ({
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
