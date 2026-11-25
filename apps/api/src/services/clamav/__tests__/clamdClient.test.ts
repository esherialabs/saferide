/**
 * The clamd client against a fake clamd on loopback (no ClamAV needed):
 * PING/VERSION, INSTREAM framing and chunking, verdicts, size limits,
 * timeouts and a clamd that is down. Every failure must be an error, never
 * a clean verdict. Synthetic bytes only; EICAR is the standard test string.
 */
import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { ClamdClient, ClamdError, parseClamdVersion, parseScanReply } from '../clamdClient.js';

/* ---------- fake clamd ---------- */

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

type FakeClamdMode = 'normal' | 'hang' | 'close' | 'error' | 'limits';

type FakeClamd = {
  port: number;
  /** Frame lengths received by INSTREAM, in order (excluding the terminator). */
  frames: number[];
  /** Bytes received by the last INSTREAM. */
  received: () => Buffer;
  commands: string[];
  set: (options: Partial<FakeClamdOptions>) => void;
  close: () => Promise<void>;
};

type FakeClamdOptions = {
  mode: FakeClamdMode;
  version: string;
  /** clamd's StreamMaxLength, in bytes. */
  streamMaxBytes: number;
};

async function startFakeClamd(initial: Partial<FakeClamdOptions> = {}): Promise<FakeClamd> {
  const options: FakeClamdOptions = {
    mode: 'normal',
    version: 'ClamAV 1.5.4/28161/Thu Oct 22 06:24:11 2026',
    streamMaxBytes: 101 * 1024 * 1024,
    ...initial,
  };
  const frames: number[] = [];
  const commands: string[] = [];
  let lastStream = Buffer.alloc(0);
  const sockets = new Set<Socket>();

  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    const parts: Buffer[] = [];
    let total = 0;

    const reply = (text: string) => {
      socket.end(`${text}\0`);
    };

    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      if (command === null) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        command = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 1);
        commands.push(command);
        if (options.mode === 'hang') return;
        if (options.mode === 'close') {
          socket.destroy();
          return;
        }
        if (command === 'zPING') return reply('PONG');
        if (command === 'zVERSION') return reply(options.version);
        if (command !== 'zINSTREAM') return reply('UNKNOWN COMMAND');
      }
      if (command !== 'zINSTREAM' || options.mode === 'hang') return;
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          lastStream = Buffer.concat(parts);
          if (options.mode === 'error') return reply('Can\'t allocate memory ERROR');
          if (options.mode === 'limits') return reply('stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND');
          return reply(lastStream.includes(EICAR) ? 'stream: Eicar-Signature FOUND' : 'stream: OK');
        }
        if (buffer.length < 4 + length) return;
        frames.push(length);
        parts.push(Buffer.from(buffer.subarray(4, 4 + length)));
        total += length;
        buffer = buffer.subarray(4 + length);
        if (total > options.streamMaxBytes) {
          lastStream = Buffer.concat(parts);
          return reply('INSTREAM size limit exceeded. ERROR');
        }
      }
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake clamd did not bind');

  return {
    port: address.port,
    frames,
    commands,
    received: () => lastStream,
    set: next => Object.assign(options, next),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/** A loopback port with nothing listening (connection refused). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/* ---------- tests ---------- */

async function* chunks(...parts: (string | Buffer)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? Buffer.from(part) : part;
}

let fake: FakeClamd | null = null;

afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function client(options: Partial<ConstructorParameters<typeof ClamdClient>[0]> = {}, fakeOptions = {}) {
  fake = await startFakeClamd(fakeOptions);
  return new ClamdClient({ host: '127.0.0.1', port: fake.port, ...options });
}

describe('clamd client: PING and VERSION', () => {
  it('pings and reads the engine and signature versions', async () => {
    const clamd = await client();
    await expect(clamd.ping()).resolves.toBeUndefined();
    const version = await clamd.version();
    expect(version).toMatchObject({
      engine: '1.5.4',
      scanner: 'clamav 1.5.4',
      signatureVersion: 28161,
      raw: 'ClamAV 1.5.4/28161/Thu Oct 22 06:24:11 2026',
    });
    expect(version.signatureDate?.toISOString()).toBe('2026-10-22T06:24:11.000Z');
    expect(fake!.commands).toEqual(['zPING', 'zVERSION']);
  });

  it('parses a clamd without a daily database', () => {
    expect(parseClamdVersion('ClamAV 1.4.6')).toMatchObject({ scanner: 'clamav 1.4.6', signatureVersion: null, signatureDate: null });
  });

  it('refuses an unexpected VERSION reply', () => {
    expect(() => parseClamdVersion('NotClam 1.0')).toThrow(ClamdError);
  });
});

describe('clamd client: INSTREAM', () => {
  it('reports a clean stream and sends it in frames no larger than the chunk size', async () => {
    const clamd = await client({ chunkBytes: 1000 });
    const body = Buffer.alloc(4500, 0x61);
    await expect(clamd.scanStream(chunks(body.subarray(0, 2500), body.subarray(2500)))).resolves.toEqual({ result: 'clean' });
    expect(fake!.frames).toEqual([1000, 1000, 500, 1000, 1000]);
    expect(fake!.received().equals(body)).toBe(true);
  });

  it('reports EICAR as infected with the detection name', async () => {
    const clamd = await client();
    await expect(clamd.scanStream(chunks('synthetic prefix ', EICAR))).resolves.toEqual({
      result: 'infected',
      signature: 'Eicar-Signature',
    });
  });

  it('refuses a stream past its own byte cap before clamd sees the rest (size_limit, not retried)', async () => {
    const clamd = await client({ maxStreamBytes: 10, chunkBytes: 4 });
    const error = await clamd.scanStream(chunks('12345678', '901234')).catch(e => e);
    expect(error).toBeInstanceOf(ClamdError);
    expect(error).toMatchObject({ code: 'size_limit', retryable: false });
    expect(fake!.frames.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10);
  });

  it("maps clamd's own StreamMaxLength refusal to size_limit", async () => {
    const clamd = await client({ chunkBytes: 8 }, { streamMaxBytes: 16 });
    const error = await clamd.scanStream(chunks(Buffer.alloc(64, 1))).catch(e => e);
    expect(error).toMatchObject({ code: 'size_limit' });
  });

  it('treats a scan-limit heuristic as "not scanned", never as a verdict', async () => {
    const clamd = await client({}, { mode: 'limits' });
    await expect(clamd.scanStream(chunks('synthetic'))).rejects.toMatchObject({ code: 'limits_exceeded', retryable: false });
  });

  it('treats a clamd ERROR reply as a retryable server error', async () => {
    const clamd = await client({}, { mode: 'error' });
    await expect(clamd.scanStream(chunks('synthetic'))).rejects.toMatchObject({ code: 'server_error', retryable: true });
  });

  it('times out when clamd never answers (fails closed, retryable)', async () => {
    const clamd = await client({ scanTimeoutMs: 300, commandTimeoutMs: 300 }, { mode: 'hang' });
    const started = Date.now();
    await expect(clamd.scanStream(chunks('synthetic'))).rejects.toMatchObject({ code: 'timeout', retryable: true });
    await expect(clamd.ping()).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reports a dropped connection as connection_closed', async () => {
    const clamd = await client({}, { mode: 'close' });
    await expect(clamd.scanStream(chunks('synthetic'))).rejects.toMatchObject({ code: 'connection_closed' });
  });

  it('the scan deadline also bounds a storage source that never yields', async () => {
    const clamd = await client({ scanTimeoutMs: 100 });
    async function* stalled(): AsyncGenerator<Uint8Array> {
      await new Promise<void>(() => {});
      yield Buffer.from('never reached');
    }
    const started = Date.now();
    await expect(clamd.scanStream(stalled())).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports clamd down as connect_failed', async () => {
    const clamd = new ClamdClient({ host: '127.0.0.1', port: await closedPort(), connectTimeoutMs: 500 });
    await expect(clamd.ping()).rejects.toMatchObject({ code: 'connect_failed', retryable: true });
    await expect(clamd.scanStream(chunks('synthetic'))).rejects.toMatchObject({ code: 'connect_failed' });
  });

  it('reports a failing source as source_error and stops reading it', async () => {
    const clamd = await client();
    let reads = 0;
    async function* failing(): AsyncGenerator<Uint8Array> {
      reads += 1;
      yield Buffer.from('partial');
      throw new Error('storage dropped the connection');
    }
    await expect(clamd.scanStream(failing())).rejects.toMatchObject({ code: 'source_error', retryable: true });
    expect(reads).toBe(1);
  });

  it('handles a large stream with backpressure', async () => {
    const clamd = await client({ chunkBytes: 64 * 1024 });
    const block = Buffer.alloc(1024 * 1024, 0x62);
    async function* big(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 24; i += 1) yield block;
    }
    await expect(clamd.scanStream(big())).resolves.toEqual({ result: 'clean' });
    expect(fake!.received().length).toBe(24 * 1024 * 1024);
  });
});

describe('parseScanReply', () => {
  it.each([
    ['stream: OK', { result: 'clean' }],
    ['stream: Win.Test.EICAR_HDB-1 FOUND', { result: 'infected', signature: 'Win.Test.EICAR_HDB-1' }],
  ])('%s', (reply, verdict) => {
    expect(parseScanReply(`${reply}\0`)).toEqual(verdict);
  });

  it.each(['', 'stream:', 'stream:  FOUND', 'OK', 'PONG'])('refuses %j', reply => {
    expect(() => parseScanReply(reply)).toThrow(ClamdError);
  });
});
