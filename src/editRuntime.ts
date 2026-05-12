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
        end: overlay.end,
        id: overlay.id,
        size: overlay.size,
        start: overlay.start,
        text: overlay.text,
        trackId: overlay.trackId,
        x: overlay.x,
        y: overlay.y,
      })),
      tracks: plan.ir.tracks,
    },
  };
}
