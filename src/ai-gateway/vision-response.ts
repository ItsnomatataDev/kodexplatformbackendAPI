import {
  KodexAiGatewayInvalidResponseError,
  type KodexAiGatewayInvalidResponseDetails,
} from './errors.js';

export type KodexAiVisionSocialFields = {
  mood: string;
  mainSubject: string;
  uncertainDetails: string;
  hook: string;
  primaryCaption: string;
  instagramCaption: string;
  facebookCaption: string;
  shortAlternative: string;
  callToAction: string;
  captionRationale: string;
  hashtags: string[];
};

export type KodexAiAnalyzeResult = {
  assistant: string;
  analysis: string;
  generatedCaption: string | null;
  requiresReview: boolean;
  social: KodexAiVisionSocialFields;
};

export type ParseKodexAiAnalyzeOptions = {
  /**
   * `reject` (default): captions without requiresReview true are an invalid response.
   * `omit`: keep analysis and drop caption fields instead of failing.
   */
  unreviewedCaptions?: 'reject' | 'omit';
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPath(root: unknown, fieldPath: string): unknown {
  let current: unknown = root;
  for (const part of fieldPath.split('.')) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[part];
  }
  return current;
}

function readNonEmptyString(root: unknown, fieldPath: string): string | null {
  const value = readPath(root, fieldPath);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function joinCaptionParts(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .join('\n\n');
}

function readCaptionText(root: unknown, fieldPath: string): string {
  return joinCaptionParts(readPath(root, fieldPath));
}

const ANALYSIS_STRING_PATHS = [
  'analysis',
  'analysis.sceneDescription',
  'analysis.description',
  'analysis.summary',
  'analysis.text',
  'sceneDescription',
  'description',
  'imageAnalysis.sceneDescription',
  'imageAnalysis.description',
  'vision.sceneDescription',
  'vision.description',
  'data.analysis',
  'data.analysis.sceneDescription',
  'data.sceneDescription',
  'result.analysis',
  'result.analysis.sceneDescription',
  'result.sceneDescription',
] as const;

const CAPTION_PREFERRED_KEYS = [
  'generatedCaption',
  'caption',
  'text',
  'body',
  'hook',
  'primary',
  'instagram',
  'facebook',
  'instagramCaption',
  'facebookCaption',
  'shortAlternative',
  'callToAction',
  'cta',
  'output',
  'content',
] as const;

const CAPTION_SKIP_KEYS = new Set([
  'requiresReview',
  'hashtags',
  'tags',
  'keywords',
  'labels',
  'objects',
  'model',
  'id',
]);

const REVIEW_PATHS = [
  'requiresReview',
  'captions.requiresReview',
  'data.requiresReview',
  'result.requiresReview',
] as const;

function invalid(
  category: KodexAiGatewayInvalidResponseDetails['category'],
  fieldPath: string,
): never {
  throw new KodexAiGatewayInvalidResponseError(
    'The AI Gateway returned an invalid response.',
    { category, fieldPath },
  );
}

function captionContainerPresent(body: unknown) {
  const captions = readPath(body, 'captions');
  return (
    asRecord(captions) != null ||
    Array.isArray(captions) ||
    typeof captions === 'string' ||
    typeof readPath(body, 'generatedCaption') === 'string' ||
    typeof readPath(body, 'instagramCaption') === 'string' ||
    typeof readPath(body, 'facebookCaption') === 'string'
  );
}

function findCaptionString(
  value: unknown,
  fieldPath: string,
  depth = 0,
): { fieldPath: string; text: string } | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? { fieldPath, text } : null;
  }
  if (depth > 4 || value == null) return null;
  if (Array.isArray(value)) {
    const joined = joinCaptionParts(value);
    if (joined) return { fieldPath, text: joined };
    for (const [index, item] of value.entries()) {
      const found = findCaptionString(item, `${fieldPath}.${index}`, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const key of CAPTION_PREFERRED_KEYS) {
    if (!Object.hasOwn(record, key) || CAPTION_SKIP_KEYS.has(key)) continue;
    const found = findCaptionString(record[key], `${fieldPath}.${key}`, depth + 1);
    if (found) return found;
  }
  for (const [key, child] of Object.entries(record)) {
    if (CAPTION_SKIP_KEYS.has(key) || (CAPTION_PREFERRED_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    const found = findCaptionString(child, `${fieldPath}.${key}`, depth + 1);
    if (found) return found;
  }
  return null;
}

function readHashtags(body: unknown): string[] {
  const candidates = [readPath(body, 'captions.hashtags'), readPath(body, 'hashtags')];
  for (const value of candidates) {
    if (!Array.isArray(value)) continue;
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function extractKodexVisionSocialFields(body: unknown): KodexAiVisionSocialFields {
  return {
    mood:
      readNonEmptyString(body, 'analysis.mood') ??
      readNonEmptyString(body, 'mood') ??
      '',
    mainSubject:
      readNonEmptyString(body, 'analysis.mainSubject') ??
      readNonEmptyString(body, 'analysis.subject') ??
      readNonEmptyString(body, 'mainSubject') ??
      '',
    uncertainDetails:
      readNonEmptyString(body, 'analysis.uncertainDetails') ??
      readNonEmptyString(body, 'analysis.uncertainties') ??
      readNonEmptyString(body, 'uncertainDetails') ??
      '',
    hook:
      readCaptionText(body, 'captions.hook') ||
      readCaptionText(body, 'hook'),
    primaryCaption:
      readCaptionText(body, 'captions.generatedCaption') ||
      readCaptionText(body, 'generatedCaption') ||
      readCaptionText(body, 'captions.caption') ||
      readCaptionText(body, 'captions.text') ||
      readCaptionText(body, 'captions.body'),
    instagramCaption:
      readCaptionText(body, 'captions.instagramCaption') ||
      readCaptionText(body, 'captions.instagram') ||
      readCaptionText(body, 'instagramCaption'),
    facebookCaption:
      readCaptionText(body, 'captions.facebookCaption') ||
      readCaptionText(body, 'captions.facebook') ||
      readCaptionText(body, 'facebookCaption'),
    shortAlternative:
      readCaptionText(body, 'captions.shortAlternative') ||
      readCaptionText(body, 'captions.shortCaption') ||
      readCaptionText(body, 'shortAlternative'),
    callToAction:
      readNonEmptyString(body, 'captions.callToAction') ??
      readNonEmptyString(body, 'captions.cta') ??
      readNonEmptyString(body, 'callToAction') ??
      '',
    captionRationale:
      readNonEmptyString(body, 'captions.rationale') ??
      readNonEmptyString(body, 'rationale') ??
      '',
    hashtags: readHashtags(body),
  };
}

function analyzedResult(params: {
  assistant: string;
  analysis: string;
  generatedCaption: string | null;
  requiresReview: boolean;
  body: unknown;
}): KodexAiAnalyzeResult {
  return {
    assistant: params.assistant,
    analysis: params.analysis,
    generatedCaption: params.generatedCaption,
    requiresReview: params.requiresReview,
    social: extractKodexVisionSocialFields(params.body),
  };
}

function readGeneratedCaption(body: unknown): { fieldPath: string; text: string } | null {
  const rootCandidates = [
    ['generatedCaption', readPath(body, 'generatedCaption')],
    ['instagramCaption', readPath(body, 'instagramCaption')],
    ['facebookCaption', readPath(body, 'facebookCaption')],
    ['captions', readPath(body, 'captions')],
  ] as const;
  for (const [fieldPath, value] of rootCandidates) {
    const found = findCaptionString(value, fieldPath);
    if (found) return found;
  }
  return null;
}

/**
 * Ubuntu KODEX AI Gateway v0.4.0 vision body: structured analysis plus optional
 * generated captions. Actionable captions must set requiresReview: true.
 * Never invents analysis or caption text.
 */
export function parseKodexAiAnalyzeResponse(
  body: unknown,
  options: ParseKodexAiAnalyzeOptions = {},
): KodexAiAnalyzeResult {
  const unreviewedCaptions = options.unreviewedCaptions ?? 'reject';
  const record = asRecord(body);
  if (!record) {
    invalid('wrong_type', '');
  }

  const analysisPath = ANALYSIS_STRING_PATHS.find((path) => {
    const value = readPath(body, path);
    return typeof value === 'string';
  });
  if (analysisPath) {
    const value = readPath(body, analysisPath);
    if (typeof value === 'string' && !value.trim()) {
      invalid('empty_field', analysisPath);
    }
  }

  const analysisObject = asRecord(readPath(body, 'analysis'));
  if (!analysisPath && analysisObject) {
    invalid('missing_field', 'analysis.sceneDescription');
  }
  if (!analysisPath) {
    invalid('missing_field', 'analysis');
  }

  const analysis = readNonEmptyString(body, analysisPath);
  if (!analysis) {
    invalid('empty_field', analysisPath);
  }

  const assistantRaw = readPath(body, 'assistant') ?? readPath(body, 'data.assistant');
  const assistant =
    typeof assistantRaw === 'string' && assistantRaw.trim()
      ? assistantRaw.trim()
      : 'kodex';

  const caption = readGeneratedCaption(body);
  const captionsPresent = captionContainerPresent(body);

  if (!captionsPresent) {
    return analyzedResult({
      assistant,
      analysis,
      generatedCaption: null,
      requiresReview: false,
      body,
    });
  }

  const reviewPath = REVIEW_PATHS.find((path) => readPath(body, path) !== undefined);
  if (!reviewPath) {
    if (unreviewedCaptions === 'omit') {
      return analyzedResult({
        assistant,
        analysis,
        generatedCaption: null,
        requiresReview: false,
        body,
      });
    }
    invalid('missing_field', 'requiresReview');
  }
  const reviewValue = readPath(body, reviewPath);
  if (typeof reviewValue !== 'boolean') {
    invalid('wrong_type', reviewPath);
  }
  if (reviewValue !== true) {
    if (unreviewedCaptions === 'omit') {
      return analyzedResult({
        assistant,
        analysis,
        generatedCaption: null,
        requiresReview: false,
        body,
      });
    }
    invalid('requires_review', reviewPath);
  }
  if (!caption) {
    invalid('missing_field', 'captions.generatedCaption');
  }

  return analyzedResult({
    assistant,
    analysis,
    generatedCaption: caption.text,
    requiresReview: true,
    body,
  });
}
