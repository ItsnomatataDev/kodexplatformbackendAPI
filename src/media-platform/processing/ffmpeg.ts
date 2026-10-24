import { spawn } from 'node:child_process';

export type VideoProbe = {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  frameRate: number | null;
};

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
};

type ProbeOutput = {
  format?: {
    duration?: string;
  };
  streams?: ProbeStream[];
};

export async function runFfmpeg(
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-protocol_whitelist', 'file,pipe', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      signal,
    });

    let stderr = '';

    child.stderr.setEncoding('utf8');

    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 16_384) {
        stderr += chunk;
      }
    });

    child.once('error', reject);

    child.once('exit', (code, exitSignal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `ffmpeg_failed:code=${code ?? 'null'}:signal=${exitSignal ?? 'null'}`,
        ),
      );
    });
  });
}

export async function probeVideo(
  input: string,
  signal: AbortSignal,
): Promise<VideoProbe> {
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    input,
  ];

  const output = await runFfprobe(args, signal);

  let parsed: ProbeOutput;

  try {
    parsed = JSON.parse(output) as ProbeOutput;
  } catch {
    throw new Error('ffprobe_invalid_json');
  }

  const streams = parsed.streams ?? [];

  const video = streams.find(
    (stream) => stream.codec_type === 'video',
  );

  const audio = streams.find(
    (stream) => stream.codec_type === 'audio',
  );

  return {
    durationSeconds: parsePositiveNumber(
      parsed.format?.duration,
    ),
    width: positiveInteger(video?.width),
    height: positiveInteger(video?.height),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    frameRate: parseFrameRate(video?.avg_frame_rate),
  };
}

async function runFfprobe(
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('ffprobe', ['-protocol_whitelist', 'file,pipe', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 1_048_576) {
        stdout += chunk;
      }
    });

    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 16_384) {
        stderr += chunk;
      }
    });

    child.once('error', reject);

    child.once('exit', (code, exitSignal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(
        new Error(
          `ffprobe_failed:code=${code ?? 'null'}:signal=${exitSignal ?? 'null'}`,
        ),
      );
    });
  });
}

function parsePositiveNumber(
  value: string | undefined,
): number | null {
  if (!value) return null;

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : null;
}

function positiveInteger(
  value: number | undefined,
): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    return null;
  }

  return value;
}

function parseFrameRate(
  value: string | undefined,
): number | null {
  if (!value) return null;

  const [numeratorRaw, denominatorRaw] = value.split('/');

  const numerator = Number(numeratorRaw);
  const denominator = Number(denominatorRaw ?? '1');

  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return null;
  }

  const result = numerator / denominator;

  return Number.isFinite(result) && result >= 0
    ? result
    : null;
}
