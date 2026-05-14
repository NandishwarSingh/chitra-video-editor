import type { StoredAssetTranscript } from './projectStore';

type TranscribeApiResponse = {
  duration: number | null;
  language: string | null;
  model: string;
  provider: string;
  segments: Array<{ end: number; start: number; text: string }>;
  text: string;
  words: Array<{ end: number; start: number; word: string }>;
};

export async function transcribeFile(file: Blob, fileName: string, languageHint?: string): Promise<StoredAssetTranscript> {
  const form = new FormData();
  form.append('file', file, fileName);
  if (languageHint) {
    form.append('language', languageHint);
  }

  const response = await fetch('/api/transcribe', { body: form, method: 'POST' });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `transcription failed (${response.status})`);
  }

  const data = (await response.json()) as TranscribeApiResponse;
  return {
    createdAt: Date.now(),
    duration: data.duration,
    language: data.language,
    model: data.model,
    provider: data.provider,
    segments: data.segments,
    text: data.text,
    words: data.words,
  };
}
