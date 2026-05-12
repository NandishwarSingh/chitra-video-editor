# Edit Array Language Coverage Rule

Every timeline, project, media, audio, text, effects, export, generated asset, search, mask, animation, keyframe, or future editing feature must be represented in Edit Array Language.

The EAL generator is not a separate creative source of truth. It is a strict, LLM-friendly serialization of the current project state. If a future feature adds a field to `ProjectAsset`, `TimelineClip`, `TextOverlay`, `ProjectPresent`, `PersistedAsset`, or `ProjectSettings`, the implementer must do one of two things:

- Add that field to the EAL program output and update `EDIT_ARRAY_FIELD_POLICY.covered`.
- Mark it as runtime-only in `EDIT_ARRAY_FIELD_POLICY.omitted` with a defensible reason.

`npm run perf:gate` enforces this. If project/timeline types change without EAL coverage, the gate fails.
