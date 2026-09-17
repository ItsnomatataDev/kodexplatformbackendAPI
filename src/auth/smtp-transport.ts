import net from 'node:net';
import tls from 'node:tls';
import type { SmtpEmailDeliveryConfig } from '../config/email-delivery.js';

export type SmtpMail = {
  to: string;
  subject: string;
  text: string;
};

export type SmtpTransportOverrides = {
  ca?: string | Buffer | Array<string | Buffer>;
};

export type SmtpCapabilities = {
  startTls: boolean;
  authLogin: boolean;
};

const SMTP_TIMEOUT_MS = 15_000;

export function parseSmtpCapabilities(ehloResponse: string): SmtpCapabilities {
  let startTls = false;
  let authLogin = false;

  for (const raw of ehloResponse.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^\d{3}[ -]/.test(line)) {
      continue;
    }

    const capability = line.slice(4).trim();
    if (!capability) {
      continue;
    }

    if (/^STARTTLS(?:\s|$)/i.test(capability)) {
      startTls = true;
      continue;
    }

    const auth = capability.match(/^AUTH(?:\s|=)(.+)$/i);
    if (!auth) {
      continue;
    }

    const mechanisms = auth[1].trim().split(/\s+/);
    if (mechanisms.some((mechanism) => mechanism.toUpperCase() === 'LOGIN')) {
      authLogin = true;
    }
  }

  return { startTls, authLogin };
}

function encodeAuthValue(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function quoteAddress(value: string): string {
  return `<${value}>`;
}

function requireAuthLogin(capabilities: SmtpCapabilities): void {
  if (!capabilities.authLogin) {
    throw new Error('SMTP AUTH LOGIN is not available.');
  }
}

function tlsConnectOptions(
  options: SmtpEmailDeliveryConfig,
  overrides: SmtpTransportOverrides,
  socket?: net.Socket,
): tls.ConnectionOptions {
  const tlsOptions: tls.ConnectionOptions = {
    host: options.host,
    port: options.port,
    servername: options.host,
    rejectUnauthorized: true,
  };

  if (overrides.ca) {
    tlsOptions.ca = overrides.ca;
  }

  if (socket) {
    tlsOptions.socket = socket;
  }

  return tlsOptions;
}

export async function sendSmtpMail(
  options: SmtpEmailDeliveryConfig,
  mail: SmtpMail,
  overrides: SmtpTransportOverrides = {},
): Promise<void> {
  const socket = await connectSmtp(options, overrides);

  try {
    await expect(socket, 220);
    await write(socket, 'EHLO kode-platform');
    const capabilities = parseSmtpCapabilities(await readMultiline(socket, 250));

    if (options.secure) {
      requireAuthLogin(capabilities);
      await authenticateAndSend(socket, options, mail);
      return;
    }

    if (!capabilities.startTls) {
      throw new Error('SMTP STARTTLS is required before authentication.');
    }

    await write(socket, 'STARTTLS');
    await expect(socket, 220);
    const upgraded = await upgradeTls(socket, options, overrides);
    await write(upgraded, 'EHLO kode-platform');
    requireAuthLogin(parseSmtpCapabilities(await readMultiline(upgraded, 250)));
    await authenticateAndSend(upgraded, options, mail);
  } finally {
    socket.destroy();
  }
}

async function authenticateAndSend(
  socket: net.Socket,
  options: SmtpEmailDeliveryConfig,
  mail: SmtpMail,
): Promise<void> {
  await write(socket, 'AUTH LOGIN');
  await expect(socket, 334);
  await write(socket, encodeAuthValue(options.username));
  await expect(socket, 334);
  await write(socket, encodeAuthValue(options.password));
  await expect(socket, 235);
  await write(socket, `MAIL FROM:${quoteAddress(options.from)}`);
  await expect(socket, 250);
  await write(socket, `RCPT TO:${quoteAddress(mail.to)}`);
  await expect(socket, 250);
  await write(socket, 'DATA');
  await expect(socket, 354);
  await write(
    socket,
    [
      `From: ${options.from}`,
      `To: ${mail.to}`,
      `Subject: ${mail.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      mail.text.replace(/^\./gm, '..'),
      '.',
    ].join('\r\n'),
  );
  await expect(socket, 250);
  await write(socket, 'QUIT');
}

function connectSmtp(
  options: SmtpEmailDeliveryConfig,
  overrides: SmtpTransportOverrides,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = options.secure
      ? tls.connect(tlsConnectOptions(options, overrides))
      : net.connect({ host: options.host, port: options.port });

    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(SMTP_TIMEOUT_MS, () => {
      onError(new Error('SMTP connection timed out.'));
    });
    socket.once('error', onError);
    socket.once(options.secure ? 'secureConnect' : 'connect', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

function upgradeTls(
  socket: net.Socket,
  options: SmtpEmailDeliveryConfig,
  overrides: SmtpTransportOverrides,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const upgraded = tls.connect(tlsConnectOptions(options, overrides, socket), () =>
      resolve(upgraded),
    );
    upgraded.setTimeout(SMTP_TIMEOUT_MS, () => {
      upgraded.destroy();
      reject(new Error('SMTP TLS upgrade timed out.'));
    });
    upgraded.once('error', reject);
  });
}

function write(socket: net.Socket, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${line}\r\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function expect(socket: net.Socket, code: number): Promise<string> {
  return readMultiline(socket, code);
}

function readMultiline(socket: net.Socket, expectedCode: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';

    const onTimeout = () => {
      cleanup();
      reject(new Error('SMTP response timed out.'));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);

      if (!buffer.endsWith('\n') && !buffer.endsWith('\r\n')) {
        return;
      }

      const complete = lines.filter((line) => line.length > 0);
      const last = complete.at(-1);

      if (!last || last.length < 4 || last[3] === '-') {
        return;
      }

      const code = Number(last.slice(0, 3));
      cleanup();

      if (code !== expectedCode) {
        reject(new Error('SMTP command failed.'));
        return;
      }

      resolve(complete.join('\n'));
    };

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}
