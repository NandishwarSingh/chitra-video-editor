export type CommandDefinition<T> = {
  aliases?: string[];
  phrase: string;
  run: T;
};

export type CommandResolution<T> =
  | { definition: CommandDefinition<T>; kind: 'match' }
  | { candidates: Array<CommandDefinition<T>>; kind: 'ambiguous' }
  | { kind: 'none' };

export function resolveCommand<T>(
  rawInput: string,
  definitions: Array<CommandDefinition<T>>,
): CommandResolution<T> {
  const query = rawInput.trim().toLowerCase();

  if (!query) {
    return { kind: 'none' };
  }

  const exact = definitions.find(
    (candidate) => candidate.phrase === query || candidate.aliases?.includes(query),
  );

  if (exact) {
    return { definition: exact, kind: 'match' };
  }

  const prefixMatches = definitions.filter((candidate) => candidate.phrase.startsWith(query));

  if (prefixMatches.length === 1) {
    return { definition: prefixMatches[0], kind: 'match' };
  }

  if (prefixMatches.length > 1) {
    return { candidates: prefixMatches, kind: 'ambiguous' };
  }

  return { kind: 'none' };
}
