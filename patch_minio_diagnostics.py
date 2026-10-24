from pathlib import Path
import difflib

path = Path('src/files/minio-storage.ts')
if not path.is_file():
    raise SystemExit('Run this from the kode-platform repository root. File not found.')
original = path.read_text()
imp_old = "import { env } from '../config/env.js';\n"
imp_new = imp_old + "import { logger } from '../config/logger.js';\n"
old = """    } catch {
      throw new ServiceUnavailableError(
        'OBJECT_STORAGE_UNAVAILABLE',
        'Object storage is unavailable.',
      );
    }
"""
new = """    } catch (error: unknown) {
      const failure = error && typeof error === 'object'
        ? error as { name?: unknown; code?: unknown; cause?: unknown }
        : null;
      const cause = failure?.cause && typeof failure.cause === 'object'
        ? failure.cause as { name?: unknown; code?: unknown }
        : null;
      const safe = (value: unknown): string =>
        typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
          ? value
          : 'unknown';

      logger.error({
        operation: method,
        errorName: safe(failure?.name),
        errorCode: safe(failure?.code),
        causeName: safe(cause?.name),
        causeCode: safe(cause?.code),
      }, 'Object storage transport failed');

      throw new ServiceUnavailableError(
        'OBJECT_STORAGE_UNAVAILABLE',
        'Object storage is unavailable.',
      );
    }
"""
if original.count(imp_old) != 1:
    raise SystemExit('Unexpected imports; refusing to edit.')
if original.count(old) != 1:
    raise SystemExit(f'Expected exactly one request() catch block; found {original.count(old)}. Refusing to edit.')
if 'Object storage transport failed' in original:
    raise SystemExit('Diagnostics already present; refusing to apply twice.')
updated = original.replace(imp_old, imp_new, 1).replace(old, new, 1)
print(''.join(difflib.unified_diff(original.splitlines(keepends=True), updated.splitlines(keepends=True), fromfile='before', tofile='after')))
path.write_text(updated)
print('Applied minimal diagnostic patch to', path)
