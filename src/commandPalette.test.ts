import { describe, expect, it } from 'vitest';
import { resolveCommand, type CommandDefinition } from './commandPalette';

const definitions: Array<CommandDefinition<string>> = [
  { phrase: 'new project', aliases: ['new'], run: 'NEW' },
  { phrase: 'open dashboard', aliases: ['dashboard'], run: 'DASH' },
  { phrase: 'rename project', aliases: ['rename'], run: 'RENAME' },
  { phrase: 'export project', run: 'EXPORT_PROJECT' },
  { phrase: 'project settings', aliases: ['settings'], run: 'SETTINGS' },
  { phrase: 'edit array', aliases: ['eal'], run: 'EAL' },
  { phrase: 'import folder', aliases: ['folder'], run: 'FOLDER' },
  { phrase: 'import', run: 'IMPORT' },
  { phrase: 'add to timeline', aliases: ['add'], run: 'ADD' },
  { phrase: 'delete asset', run: 'DELETE_ASSET' },
  { phrase: 'split', run: 'SPLIT' },
  { phrase: 'delete', run: 'DELETE' },
  { phrase: 'add text', aliases: ['text'], run: 'TEXT' },
  { phrase: 'export', run: 'EXPORT' },
  { phrase: 'undo', run: 'UNDO' },
  { phrase: 'redo', run: 'REDO' },
];

function resolveTo(input: string): string | null {
  const result = resolveCommand(input, definitions);
  return result.kind === 'match' ? result.definition.run : null;
}

describe('command palette resolution', () => {
  it('returns the exact-match command when the input matches a phrase', () => {
    expect(resolveTo('import')).toBe('IMPORT');
    expect(resolveTo('delete')).toBe('DELETE');
    expect(resolveTo('export')).toBe('EXPORT');
  });

  it('returns the exact-match command when the input matches an alias', () => {
    expect(resolveTo('folder')).toBe('FOLDER');
    expect(resolveTo('settings')).toBe('SETTINGS');
    expect(resolveTo('eal')).toBe('EAL');
  });

  it('does not let "import folder" shadow "import"', () => {
    expect(resolveTo('import')).toBe('IMPORT');
    expect(resolveTo('import folder')).toBe('FOLDER');
  });

  it('does not let "delete asset" shadow "delete"', () => {
    expect(resolveTo('delete')).toBe('DELETE');
    expect(resolveTo('delete asset')).toBe('DELETE_ASSET');
  });

  it('reports ambiguous prefixes instead of silently picking the first', () => {
    const result = resolveCommand('i', definitions);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((c) => c.phrase).sort()).toEqual(['import', 'import folder']);
    }
  });

  it('resolves an unambiguous prefix to its single match', () => {
    expect(resolveTo('un')).toBe('UNDO');
    expect(resolveTo('split')).toBe('SPLIT');
    expect(resolveTo('rena')).toBe('RENAME');
    expect(resolveTo('redo')).toBe('REDO');
  });

  it('treats prefixes that match multiple phrases as ambiguous', () => {
    expect(resolveCommand('exp', definitions).kind).toBe('ambiguous');
    expect(resolveCommand('imp', definitions).kind).toBe('ambiguous');
    expect(resolveCommand('del', definitions).kind).toBe('ambiguous');
  });

  it('returns none for empty input or no-match input', () => {
    expect(resolveCommand('', definitions).kind).toBe('none');
    expect(resolveCommand('xyz', definitions).kind).toBe('none');
  });
});
