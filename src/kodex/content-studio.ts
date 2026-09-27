import { ServiceUnavailableError, ValidationError } from '../http/errors.js';
import type { FileStorage } from '../files/storage.js';
import { CONTENT_REVIEW_ASSETS_BUCKET } from '../content/buckets.js';
import {
  isLlmReady,
  llmChatText,
  llmVisionText,
} from './llm-client.js';

export type ContentStudioCaptionInput = {
  clientName?: string;
  postTitle?: string;
  existingCaption?: string;
  mediaDescription?: string;
  platform?: string;
  tone?: string;
  instruction?: string;
  websiteContext?: string;
  clientAiProfile?: Record<string, string | undefined> | null;
  captionExamples?: Array<{
    caption?: string;
    outcome?: 'approved' | 'rejected';
    platform?: string;
    notes?: string;
  }>;
};

export type ContentStudioCaptionOutput = {
  hook: string;
  generatedCaption: string;
  callToAction: string;
  hashtags: string[];
  shortAlternative: string;
  rationale: string;
};

export type ContentStudioAnalyzeInput = {
  clientName?: string;
  postTitle?: string;
  existingCaption?: string;
  imageDataUrl?: string;
  imageUrl?: string;
  storagePath?: string | null;
  fileName?: string;
  websiteContext?: string;
  instruction?: string;
  platform?: string;
  tone?: string;
  clientAiProfile?: Record<string, string | undefined> | null;
};

export type ContentStudioAnalyzeOutput = {
  mood: string;
  sceneDescription: string;
  hook: string;
  generatedCaption: string;
  callToAction: string;
  hashtags: string[];
  shortAlternative: string;
  rationale: string;
  instagramCaption: string;
  facebookCaption: string;
};

function requireLlm() {
  if (!isLlmReady()) {
    throw new ServiceUnavailableError(
      'KODEX_NOT_CONFIGURED',
      'KODEX requires LLM_API_KEY (or OPENAI_API_KEY). Cursor API keys are for agents, not captions.',
    );
  }
}

function profileLines(profile: Record<string, string | undefined> | null | undefined) {
  const p = profile ?? {};
  return [
    p.brandVoice ? `Brand voice: ${p.brandVoice}` : null,
    p.audience ? `Audience: ${p.audience}` : null,
    p.services ? `Services/offers: ${p.services}` : null,
    p.contentPillars ? `Content pillars: ${p.contentPillars}` : null,
    p.captionStyle ? `Caption style: ${p.captionStyle}` : null,
    p.ctaStyle ? `CTA style: ${p.ctaStyle}` : null,
    p.hashtagStyle ? `Hashtag style: ${p.hashtagStyle}` : null,
    p.emojiStyle ? `Emoji style: ${p.emojiStyle}` : null,
    p.wordsToUse ? `Words to use: ${p.wordsToUse}` : null,
    p.wordsToAvoid ? `Words to avoid: ${p.wordsToAvoid}` : null,
    p.platformNotes ? `Platform notes: ${p.platformNotes}` : null,
  ].filter(Boolean);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const slice = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  try {
    const parsed = JSON.parse(slice) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function pickHashtags(record: Record<string, unknown>) {
  return Array.isArray(record.hashtags) ? record.hashtags.map(String) : [];
}

function buildCaptionPrompt(input: ContentStudioCaptionInput) {
  const examples = (input.captionExamples ?? [])
    .filter((example) => example.caption?.trim())
    .slice(0, 8)
    .map((example, index) => {
      const labels = [
        example.outcome,
        example.platform ? `platform: ${example.platform}` : null,
        example.notes ? `notes: ${example.notes}` : null,
      ]
        .filter(Boolean)
        .join('; ');
      return `${index + 1}. ${labels}\n${example.caption?.trim()}`;
    });

  const lines = profileLines(input.clientAiProfile);
  return [
    'Write like a senior social media copywriter with taste, not like a generic AI assistant.',
    'Quality bar:',
    '- Lead with a strong hook or spotlight moment.',
    '- Make the caption specific to the person, place, image, or achievement.',
    '- Find the human meaning: impact, pride, craft, community, transformation, memory, belonging, or momentum.',
    '- For scenic, travel, hospitality, wildlife, food, lifestyle, or destination posts: write with calm sensory detail.',
    '- When media analysis is not available, infer gently from the post title and client context. Do not invent precise facts.',
    '- Use vivid but natural language. Avoid stiff corporate words and empty praise.',
    '- Never use filler like "in today\'s fast-paced world", "discover", "unlock", or "elevate" unless the client profile asks for it.',
    '- Hashtags should feel intentional, local, and relevant.',
    `Client: ${input.clientName ?? 'Unknown client'}`,
    `Post title: ${input.postTitle ?? 'Untitled post'}`,
    lines.length > 0 ? ['', 'Client AI voice profile:', ...lines].join('\n') : null,
    input.websiteContext
      ? [
          '',
          'Live website research (factual grounding — do not invent beyond this):',
          input.websiteContext,
        ].join('\n')
      : null,
    examples.length > 0
      ? ['', 'Caption training examples:', ...examples].join('\n')
      : null,
    input.platform ? `Platform: ${input.platform}` : null,
    input.tone ? `Tone: ${input.tone}` : null,
    input.mediaDescription ? `Media description: ${input.mediaDescription}` : null,
    input.existingCaption ? `Existing caption: ${input.existingCaption}` : null,
    input.instruction ? `Instruction: ${input.instruction}` : null,
    '',
    'Use approved examples as style guidance. Avoid repeating rejected example patterns.',
    'Return strict JSON: { hook, generatedCaption, callToAction, hashtags, shortAlternative, rationale }',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildAnalyzePrompt(input: ContentStudioAnalyzeInput) {
  const lines = profileLines(input.clientAiProfile);
  return [
    'Analyze the media, then write like a senior social media copywriter with taste.',
    'The caption should feel specific, human, polished, and ready to post.',
    'Find the strongest emotional angle in the image: impact, pride, craft, community, transformation, memory, belonging, or momentum.',
    'Avoid generic AI phrasing, stiff corporate copy, and empty hype.',
    `Client: ${input.clientName ?? 'Client'}`,
    `Post: ${input.postTitle ?? 'Schedule post'}`,
    lines.length > 0 ? ['Client AI voice profile:', ...lines].join('\n') : null,
    input.websiteContext
      ? [
          'Live website research (factual grounding — do not invent beyond this):',
          input.websiteContext,
        ].join('\n')
      : null,
    input.existingCaption ? `Existing caption: ${input.existingCaption}` : null,
    input.fileName ? `File name: ${input.fileName}` : null,
    input.platform ? `Platform: ${input.platform}` : null,
    input.tone ? `Tone: ${input.tone}` : null,
    input.instruction ? `Instruction: ${input.instruction}` : null,
    '',
    'Analyze this image for a social media schedule post.',
    'Return strict JSON only with keys:',
    'mood, sceneDescription, hook, generatedCaption, callToAction, hashtags (array),',
    'shortAlternative, rationale, instagramCaption, facebookCaption.',
    'Do not invent brand names that are not visible. Be concise and professional.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function generateContentStudioCaption(
  input: ContentStudioCaptionInput,
): Promise<ContentStudioCaptionOutput> {
  requireLlm();
  const aiText = await llmChatText({
    systemPrompt:
      'You generate social media caption suggestions. Return JSON only with keys hook, generatedCaption, callToAction, hashtags (array), shortAlternative, rationale.',
    userMessage: buildCaptionPrompt(input),
    temperature: 0.7,
    maxTokens: 700,
  });
  const parsed = parseJsonObject(aiText);
  return {
    hook: pickString(parsed, ['hook', 'openingHook']),
    generatedCaption: pickString(parsed, [
      'generatedCaption',
      'suggestedCaption',
      'caption',
    ]),
    callToAction: pickString(parsed, ['callToAction', 'cta']),
    hashtags: pickHashtags(parsed),
    shortAlternative: pickString(parsed, ['shortAlternative', 'shortCaption']),
    rationale: pickString(parsed, ['rationale', 'whyThisWorks']),
  };
}

function bytesToBase64(bytes: Buffer) {
  return bytes.toString('base64');
}

async function resolveImageDataUrl(params: {
  files: FileStorage;
  organizationId: string;
  input: ContentStudioAnalyzeInput;
}) {
  const { files, organizationId, input } = params;
  if (input.imageDataUrl?.startsWith('data:image/')) {
    return input.imageDataUrl;
  }

  const storagePath = input.storagePath?.trim() || null;
  if (storagePath) {
    if (!storagePath.startsWith(`${organizationId}/`)) {
      throw new ValidationError('storagePath must belong to this organization.', {
        field: 'storagePath',
      });
    }
    if (files.headObject) {
      const head = await files.headObject(CONTENT_REVIEW_ASSETS_BUCKET, storagePath);
      if (!head) {
        throw new ValidationError('Media object was not found in storage.', {
          field: 'storagePath',
        });
      }
      if (head.sizeBytes != null && head.sizeBytes > 12 * 1024 * 1024) {
        throw new ValidationError('Image exceeds 12MB analysis limit.', {
          field: 'storagePath',
        });
      }
    }
    const object = await files.getObject(CONTENT_REVIEW_ASSETS_BUCKET, storagePath);
    if (!object) {
      throw new ValidationError('Media object was not found in storage.', {
        field: 'storagePath',
      });
    }
    if (object.body.byteLength > 12 * 1024 * 1024) {
      throw new ValidationError('Image exceeds 12MB analysis limit.', {
        field: 'storagePath',
      });
    }
    const mime = object.contentType?.split(';')[0]?.trim() || 'image/jpeg';
    if (!mime.startsWith('image/')) {
      throw new ValidationError('Only image objects can be analyzed directly.', {
        field: 'storagePath',
      });
    }
    return `data:${mime};base64,${bytesToBase64(object.body)}`;
  }

  const imageUrl = input.imageUrl?.trim();
  if (imageUrl?.startsWith('data:image/')) {
    return imageUrl;
  }

  throw new ValidationError(
    'Provide storagePath (preferred) or a data:image URL for analysis.',
    { field: 'storagePath' },
  );
}

export async function analyzeContentStudioMedia(params: {
  files: FileStorage;
  organizationId: string;
  input: ContentStudioAnalyzeInput;
}): Promise<ContentStudioAnalyzeOutput> {
  requireLlm();
  const imageDataUrl = await resolveImageDataUrl(params);
  const aiText = await llmVisionText({
    prompt: buildAnalyzePrompt(params.input),
    imageDataUrl,
    temperature: 0.5,
    maxTokens: 1200,
  });
  const parsed = parseJsonObject(aiText);
  const generatedCaption = pickString(parsed, [
    'generatedCaption',
    'suggestedCaption',
    'caption',
  ]);
  return {
    mood: pickString(parsed, ['mood']),
    sceneDescription: pickString(parsed, ['sceneDescription', 'description']),
    hook: pickString(parsed, ['hook']),
    generatedCaption,
    callToAction: pickString(parsed, ['callToAction', 'cta']),
    hashtags: pickHashtags(parsed),
    shortAlternative: pickString(parsed, ['shortAlternative', 'shortCaption']),
    rationale: pickString(parsed, ['rationale']),
    instagramCaption:
      pickString(parsed, ['instagramCaption']) || generatedCaption,
    facebookCaption:
      pickString(parsed, ['facebookCaption']) || generatedCaption,
  };
}
