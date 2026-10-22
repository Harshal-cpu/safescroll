import { PROFILES } from './profiles.js';

export const MODERATION_DEFAULTS = Object.freeze({
  ocrEnabled: PROFILES.ocr.enabled,
  imageEnabled: PROFILES.image.enabled,
  lexiconEnabled: PROFILES.lexicon.enabled
});

export function normalizeModerationSettings(values = {}) {
  return Object.fromEntries(Object.entries(MODERATION_DEFAULTS).map(([key, fallback]) =>
    [key, typeof values[key] === 'boolean' ? values[key] : fallback]
  ));
}
