//! Tool catalog exposed to the model.
//!
//! ## Design
//!
//! We expose ONE tool — `apply_eal` — that takes a complete Edit Array
//! Language program. The model already receives the current EAL on every
//! turn via the editor context, so when it wants to edit anything (cut,
//! caption, transform, audio, fade, even add/remove tracks) it emits the
//! desired new program as a single JSON array.
//!
//! This is deliberately more powerful than a per-action tool catalog:
//!   - The model can express anything EAL can express. New editor
//!     capabilities surface to the model automatically as soon as they're
//!     added to EAL — no schema edits required here.
//!   - One round-trip per edit, regardless of how many primitive operations
//!     it represents (the model sees the whole picture and acts holistically
//!     instead of chaining 17 narrow calls).
//!   - The frontend gets to compile-validate-diff before the user applies,
//!     so a malformed program is caught and shown back to the model.
//!
//! Anything the existing reducer can produce, EAL → IR → runtime can
//! produce. Anything the existing reducer rejects (overlap, out-of-range,
//! unknown asset) bubbles back as a diagnostic the model can correct on the
//! next turn.

use serde_json::{json, Value};

pub fn tool_catalog() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "apply_eal",
                "description":
                    "Apply a new Edit Array Language (EAL) program to the editor. The argument is the COMPLETE new program (not a diff) representing the desired timeline state after the edit. The editor compiles and validates it; on success the user sees a one-click 'Apply' card. \
                     Use this for any change: cut/split, add/remove text, move clips between tracks, trim, audio adjustments (volume/mute/fade), transforms (position/scale/rotation), color grade, project settings, track changes, the lot. \
                     Always start from the EAL shown in the current context, modify only the relevant instructions, and emit the result. Do NOT omit the `schema`, `project`, `timeline`, `track`, `composite`, `export_settings` headers — they're load-bearing.",
                "parameters": {
                    "type": "object",
                    "required": ["program"],
                    "properties": {
                        "program": {
                            "type": "array",
                            "description":
                                "Complete EAL program. Same JSON shape as the program in the `Edit Array Language (current timeline)` block of the system context — an array of `[opcode, ...payload]` tuples. Must be a valid, self-contained program (the editor will reject malformed input)."
                        },
                        "summary": {
                            "type": "string",
                            "description": "One-line, human-readable description of what changes vs. the previous program. Shown on the confirmation card."
                        }
                    },
                    "additionalProperties": false
                }
            }
        }
    ])
}
