import { compileEditArrayToIr, type EditArrayDiagnostic, type EditArrayIr } from './editArrayIr';
import type { EditArrayProgram } from './editArrayLanguage';

export type EditRuntimeOperation =
  | { type: 'IMPORT_ASSET'; assetId: string; name: string }
  | { type: 'CREATE_TRACK'; trackId: string; kind: 'audio' | 'text' | 'video'; index: number; name: string }
  | { type: 'PLACE_CLIP'; assetId: string; clipId: string; sourceIn: number; sourceOut: number; timelineStart: number; trackId: string }
  | { type: 'SET_AUDIO'; clipId: string; fadeIn: number; fadeOut: number; muted: boolean; volume: number }
  | { type: 'APPLY_EFFECT'; clipId: string; settings: EditArrayIr['clips'][number]['effects'] }
  | { type: 'SET_TRANSFORM'; clipId: string; transform: EditArrayIr['clips'][number]['transform'] }
  | { type: 'ADD_TEXT'; textId: string; text: string; start: number; end: number }
  | { type: 'ADD_CUT'; afterClip: string; at: number }
  | { type: 'SET_EXPORT'; fps: number; height: number; width: number };

export type CompiledEditPlan = {
  diagnostics: EditArrayDiagnostic[];
  ir: EditArrayIr;
  operations: EditRuntimeOperation[];
};

export function compileEditArrayProgram(program: EditArrayProgram | readonly unknown[]): CompiledEditPlan {
  const ir = compileEditArrayToIr(program);
  const operations: EditRuntimeOperation[] = [];

  ir.assets.forEach((asset) => {
    operations.push({ assetId: asset.id, name: asset.name, type: 'IMPORT_ASSET' });
  });

  ir.tracks.forEach((track) => {
    operations.push({ index: track.index, kind: track.kind, name: track.name, trackId: track.id, type: 'CREATE_TRACK' });
  });

  ir.clips.forEach((clip) => {
    operations.push({
      assetId: clip.assetId,
      clipId: clip.id,
      sourceIn: clip.sourceIn,
      sourceOut: clip.sourceOut,
      timelineStart: clip.timelineStart,
      trackId: clip.trackId,
      type: 'PLACE_CLIP',
    });
    operations.push({
      clipId: clip.id,
      fadeIn: clip.fadeIn,
      fadeOut: clip.fadeOut,
      muted: clip.muted,
      type: 'SET_AUDIO',
      volume: clip.volume,
    });
    operations.push({ clipId: clip.id, settings: clip.effects, type: 'APPLY_EFFECT' });
    operations.push({ clipId: clip.id, transform: clip.transform, type: 'SET_TRANSFORM' });
  });

  ir.cuts.forEach((cut) => operations.push({ afterClip: cut.afterClip, at: cut.at, type: 'ADD_CUT' }));
  ir.textOverlays.forEach((overlay) => {
    operations.push({
      end: overlay.end,
      start: overlay.start,
      text: overlay.text,
      textId: overlay.id,
      type: 'ADD_TEXT',
    });
  });

  if (ir.exportSettings) {
    operations.push({
      fps: ir.exportSettings.fps,
      height: ir.exportSettings.height,
      type: 'SET_EXPORT',
      width: ir.exportSettings.width,
    });
  }

  return {
    diagnostics: ir.diagnostics,
    ir,
    operations,
  };
}
