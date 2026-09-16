import { stdin, stdout } from 'node:process';
import { env } from '../src/config/env.js';
import { db } from '../src/db/pool.js';
import { withTransaction } from '../src/db/transaction.js';
import {
  assertDevelopmentBootstrap,
  bootstrapDevelopmentPassword,
  parseBootstrapCommandLine,
} from '../src/auth/bootstrap-password.js';
import { PostgresAuthStore } from '../src/auth/postgres-store.js';
import { AppError } from '../src/http/errors.js';

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY || !stdout.isTTY) {
      reject(
        new Error(
          'Password bootstrap must be run in an interactive terminal.',
        ),
      );
      return;
    }

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const finish = (result: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      resolve(result);
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          finish(value);
          return;
        }

        if (char === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exitCode = 1;
          process.exit(1);
        }

        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }

        if (char < ' ') {
          continue;
        }

        value += char;
      }
    };

    stdin.on('data', onData);
  });
}

async function run() {
  assertDevelopmentBootstrap(env.appEnv);

  const { userId, force } = parseBootstrapCommandLine(process.argv.slice(2));
  const password = await promptHidden('Password: ');
  const confirmation = await promptHidden('Confirm password: ');

  if (password !== confirmation) {
    throw new Error('Passwords do not match. No credential was stored.');
  }

  const result = await bootstrapDevelopmentPassword({
    appEnv: env.appEnv,
    userId,
    password,
    force,
    store: new PostgresAuthStore(),
    withTransaction,
  });

  console.log('Password credential stored.');
  console.log(`user_id: ${result.userId}`);
  console.log(`email: ${result.email ?? '(none)'}`);
  console.log(`replaced: ${result.replaced}`);
}

try {
  await run();
} catch (error) {
  if (error instanceof AppError) {
    console.error(error.message);
  } else {
    console.error(
      error instanceof Error
        ? error.message
        : 'Failed to bootstrap development password.',
    );
  }
  process.exitCode = 1;
} finally {
  await db.end();
}
