import fs from 'node:fs';

export function readTlsCaFile(
  filePath: string | undefined,
  label: string,
): string | undefined {
  if (filePath == null || filePath.trim().length === 0) {
    return undefined;
  }

  try {
    const contents = fs.readFileSync(filePath, 'utf8');
    if (contents.trim().length === 0) {
      throw new Error(`${label} CA file is empty.`);
    }
    return contents;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) {
      throw error;
    }

    throw new Error(`${label} CA file cannot be read.`);
  }
}
