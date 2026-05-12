import type { CompiledEditPlan } from './editCompiler';
import type { ProjectPresent } from './projectModel';
import type { VisualReviewReport } from './visualReviewAgent';
import { clamp } from './time';

export type EditRepairPatch =
  | { type: 'CLAMP_TEXT_SAFE_AREA'; textId: string; x: number; y: number }
  | { type: 'CENTER_CLIP_TRANSFORM'; clipId: string }
  | { type: 'SOFTEN_EFFECTS'; clipId: string };

export type EditRepairPlan = {
  patches: EditRepairPatch[];
};

export function createEditRepairPlan(report: VisualReviewReport): EditRepairPlan {
  const patches: EditRepairPatch[] = [];

  report.issues.forEach((issue) => {
    if (!issue.targetId) {
      return;
    }

    if (issue.code === 'text_near_edge') {
      patches.push({
        textId: issue.targetId,
        type: 'CLAMP_TEXT_SAFE_AREA',
        x: 0.5,
        y: 0.18,
      });
    }

    if (issue.code === 'effect_overdrive') {
      patches.push({
        clipId: issue.targetId,
        type: 'SOFTEN_EFFECTS',
      });
    }

    if (issue.code === 'clip_transform_edge') {
      patches.push({
        clipId: issue.targetId,
        type: 'CENTER_CLIP_TRANSFORM',
      });
    }
  });

  return { patches };
}

export function applyEditRepairPlan(project: ProjectPresent, repairPlan: EditRepairPlan): ProjectPresent {
  return repairPlan.patches.reduce<ProjectPresent>((current, patch) => {
    if (patch.type === 'CLAMP_TEXT_SAFE_AREA') {
      return {
        ...current,
        textOverlays: current.textOverlays.map((overlay) =>
          overlay.id === patch.textId
            ? {
                ...overlay,
                x: clamp(overlay.x, 0.08, 0.92),
                y: clamp(overlay.y, 0.08, 0.92),
              }
            : overlay,
        ),
      };
    }

    if (patch.type === 'SOFTEN_EFFECTS') {
      return {
        ...current,
        clips: current.clips.map((clip) =>
          clip.id === patch.clipId
            ? {
                ...clip,
                effects: {
                  brightness: clamp(clip.effects.brightness, -0.3, 0.3),
                  contrast: clamp(clip.effects.contrast, 0.6, 1.6),
                  saturation: clamp(clip.effects.saturation, 0.2, 1.8),
                },
              }
            : clip,
        ),
      };
    }

    return {
      ...current,
      clips: current.clips.map((clip) =>
        clip.id === patch.clipId
          ? {
              ...clip,
              transform: {
                scale: clamp(clip.transform.scale, 0.25, 3),
                x: clamp(clip.transform.x, 0.05, 0.95),
                y: clamp(clip.transform.y, 0.05, 0.95),
              },
            }
          : clip,
      ),
    };
  }, project);
}

export type EditRepairLoopOptions = {
  maxPasses?: number;
  rereview?: (project: ProjectPresent) => VisualReviewReport;
};

export async function runEditRepairLoop(
  plan: CompiledEditPlan,
  project: ProjectPresent,
  initialReview: VisualReviewReport,
  options: EditRepairLoopOptions = {},
) {
  const maxPasses = Math.max(1, options.maxPasses ?? 2);
  let repairedProject = project;
  let review = initialReview;
  let repairPlan = createEditRepairPlan(review);
  let lastIssueCount = -1;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (repairPlan.patches.length === 0) {
      break;
    }

    repairedProject = applyEditRepairPlan(repairedProject, repairPlan);

    if (!options.rereview) {
      repairPlan = { patches: [] };
      break;
    }

    review = options.rereview(repairedProject);
    repairPlan = createEditRepairPlan(review);

    if (review.issues.length === lastIssueCount) {
      break;
    }

    lastIssueCount = review.issues.length;
  }

  return {
    compilerDiagnostics: plan.diagnostics,
    issues: review.issues,
    project: repairedProject,
    repairPlan,
  };
}
