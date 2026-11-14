/**
 * A small clamd (ClamAV daemon) client over TCP, in plain Node: PING,
 * VERSION and INSTREAM, using clamd's null-terminated ("z") commands.
 *
 * INSTREAM sends the file as frames (4-byte big-endian length, then that
 * many bytes) and ends with a zero-length frame; clamd answers once:
 *   stream: OK                                  clean
 *   stream: <signature> FOUND                   infected
 *   INSTREAM size limit exceeded. ERROR         over clamd's StreamMaxLength
 *   <reason> ERROR                              clamd could not scan
 *
 * Every call has a deadline and the stream has a byte cap, so a stuck clamd
 * or an oversized object fails with a ClamdError instead of hanging. A
 * failure is never a verdict: callers treat any error as "not scanned".
 * Nothing here logs; errors carry a code and no file content.
 */
import { connect, type Socket } from 'node:net';

export type ClamdErrorCode =
  | 'connect_failed'
  | 'timeout'
  | 'connection_closed'
  | 'protocol_error'
  | 'server_error'
  | 'size_limit'
  | 'limits_exceeded'
  | 'source_error';

/** Codes worth retrying: clamd or the network may recover. The rest fail closed at once. */
const RETRYABLE: ReadonlySet<ClamdErrorCode> = new Set([
  'connect_failed',
  'timeout',
  'connection_closed',
  'protocol_error',
  'server_error',
  'source_error',
]);

export class ClamdError extends Error {
  readonly code: ClamdErrorCode;
  readonly retryable: boolean;

  constructor(code: ClamdErrorCode, message: string) {
    super(message);
    this.name = 'ClamdError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }
}

export type ClamdVerdict = { result: 'clean' } | { result: 'infected'; signature: string };

export type ClamdVersion = {
  /** clamd's reply, e.g. "ClamAV 1.5.4/28161/Thu Oct 22 06:24:11 2026". */
  raw: string;
  /** Engine version, e.g. "1.5.4". */
  engine: string;
  /** The scanner name a malware scan policy approves, e.g. "clamav 1.5.4". */
  scanner: string;
  /** daily signature database version, e.g. 28161 (null when clamd has none loaded). */
  signatureVersion: number | null;
  /** daily database build time (UTC), or null. */
  signatureDate: Date | null;
};

export type ClamdClientOptions = {
  host: string;
  port: number;
  /** TCP connect budget. */
  connectTimeoutMs?: number;
  /** Whole PING / VERSION exchange. */
  commandTimeoutMs?: number;
  /** Whole INSTREAM exchange, from connect to verdict. */
  scanTimeoutMs?: number;
  /** Largest frame sent to clamd. */
  chunkBytes?: number;
  /** Refuse (size_limit) once the stream passes this many bytes. */
  maxStreamBytes?: number;
};

const DEFAULTS = {
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 10_000,
  scanTimeoutMs: 120_000,
  chunkBytes: 64 * 1024,
  maxStreamBytes: 100 * 1024 * 1024,
};

const MAX_REPLY_BYTES = 4096;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu Oct 22 06:24:11 2026" (clamd prints the database time in its TZ, UTC in the image). */
function parseClamdDate(value: string): Date | null {
  const match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]);
  if (month < 0) return null;
  const date = new Date(Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])));
  return Number.isFinite(date.getTime()) ? date : null;
}

export function parseClamdVersion(raw: string): ClamdVersion {
  const text = raw.trim();
  const match = /^ClamAV (\d+\.\d+\.\d+[0-9A-Za-z.~+-]*)(?:\/(\d+)\/(.+))?$/.exec(text);
  if (!match) throw new ClamdError('protocol_error', 'Unexpected clamd VERSION reply');
  return {
    raw: text,
    engine: match[1],
    scanner: `clamav ${match[1]}`,
    signatureVersion: match[2] ? Number(match[2]) : null,
    signatureDate: match[3] ? parseClamdDate(match[3]) : null,
  };
}

/** Maps clamd's INSTREAM reply to a verdict, or throws for anything that is not one. */
export function parseScanReply(raw: string): ClamdVerdict {
  const text = raw.replace(/\0+$/, '').trim();
  if (text.endsWith(' ERROR')) {
    if (/size limit exceeded/i.test(text)) throw new ClamdError('size_limit', 'clamd refused the stream size');
    throw new ClamdError('server_error', 'clamd could not scan the stream');
  }
  const body = text.startsWith('stream: ') ? text.slice('stream: '.length) : null;
  if (body === 'OK') return { result: 'clean' };
  if (body?.endsWith(' FOUND')) {
    const signature = body.slice(0, -' FOUND'.length).trim();
    if (!signature) throw new ClamdError('protocol_error', 'clamd reported a detection without a name');
    // AlertExceedsMax: a file or archive past a scan limit was not fully
    // scanned. That is not a verdict on the content, so it never counts as
    // infected or clean.
    if (signature.startsWith('Heuristics.Limits.Exceeded')) {
      throw new ClamdError('limits_exceeded', 'clamd could not scan the whole file within its limits');
    }
    return { result: 'infected', signature: signature.slice(0, 200) };
  }
  throw new ClamdError('protocol_error', 'Unexpected clamd INSTREAM reply');
}

type Exchange = {
  socket: Socket;
  /** Resolves with clamd's reply (up to its first NUL), rejects on error, close or deadline. */
  reply: Promise<string>;
  /** True once a reply arrived or the exchange failed: stop writing. */
  settled: () => boolean;
  fail: (error: ClamdError) => void;
  close: () => void;
};

export class ClamdClient {
  private readonly options: Required<ClamdClientOptions>;

  constructor(options: ClamdClientOptions) {
    this.options = { ...DEFAULTS, ...options };
    if (this.options.chunkBytes < 1 || this.options.chunkBytes > 16 * 1024 * 1024) {
      throw new Error('chunkBytes must be between 1 byte and 16 MiB');
    }
  }

  async ping(): Promise<void> {
    const reply = await this.command('PING');
    if (reply !== 'PONG') throw new ClamdError('protocol_error', 'Unexpected clamd PING reply');
  }

  async version(): Promise<ClamdVersion> {
    return parseClamdVersion(await this.command('VERSION'));
  }

  /** Streams `source` to clamd (INSTREAM) and returns its verdict. */
  async scanStream(source: AsyncIterable<Uint8Array>): Promise<ClamdVerdict> {
    const exchange = await this.open(this.options.scanTimeoutMs);
    const { socket } = exchange;
    const header = Buffer.from('zINSTREAM\0', 'latin1');
    let sent = 0;
    const send = async () => {
      await this.write(exchange, header);
      try {
        for await (const chunk of source) {
          if (exchange.settled()) break;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          sent += buffer.length;
          if (sent > this.options.maxStreamBytes) {
            exchange.fail(new ClamdError('size_limit', 'The stream exceeds the scan size limit'));
            break;
          }
          for (let offset = 0; offset < buffer.length && !exchange.settled(); offset += this.options.chunkBytes) {
            const piece = buffer.subarray(offset, Math.min(offset + this.options.chunkBytes, buffer.length));
            const length = Buffer.allocUnsafe(4);
            length.writeUInt32BE(piece.length, 0);
            await this.write(exchange, Buffer.concat([length, piece]));
          }
        }
      } catch (error) {
        if (error instanceof ClamdError) throw error;
        // The source (object storage) failed mid-stream: nothing was scanned.
        exchange.fail(new ClamdError('source_error', 'The object could not be read for scanning'));
      }
      if (!exchange.settled()) await this.write(exchange, Buffer.alloc(4));
    };
    try {
      // A storage iterator can stop yielding without rejecting. The socket
      // deadline must still release this caller; the owner then destroys
      // the storage stream in its finally block.
      const reply = await Promise.race([send().then(() => exchange.reply), exchange.reply]);
      return parseScanReply(reply);
    } finally {
      exchange.close();
      socket.destroy();
    }
  }

  private async command(name: 'PING' | 'VERSION'): Promise<string> {
    const exchange = await this.open(this.options.commandTimeoutMs);
    try {
      await this.write(exchange, Buffer.from(`z${name}\0`, 'latin1'));
      return (await exchange.reply).replace(/\0+$/, '').trim();
    } finally {
      exchange.close();
      exchange.socket.destroy();
    }
  }

  /** Connects and sets the exchange deadline (which covers the connect). */
  private open(deadlineMs: number): Promise<Exchange> {
    return new Promise((resolveOpen, rejectOpen) => {
      const socket = connect({ host: this.options.host, port: this.options.port });
      socket.setNoDelay(true);
      let connected = false;
      let done = false;
      let received = Buffer.alloc(0);
      let resolveReply!: (value: string) => void;
      let rejectReply!: (error: ClamdError) => void;
      const reply = new Promise<string>((resolve, reject) => {
        resolveReply = resolve;
        rejectReply = reject;
      });
      // A rejected reply nobody awaits yet (e.g. a write failed first) must not crash the process.
      reply.catch(() => undefined);

      const settle = (outcome: { value: string } | { error: ClamdError }) => {
        if (done) return;
        done = true;
        clearTimeout(connectTimer);
        clearTimeout(deadline);
        if ('value' in outcome) resolveReply(outcome.value);
        else rejectReply(outcome.error);
        if (!connected) {
          connected = true;
          rejectOpen('error' in outcome ? outcome.error : new ClamdError('protocol_error', 'clamd replied before the command'));
        }
      };
      const fail = (error: ClamdError) => {
        settle({ error });
        socket.destroy();
      };

      const connectTimer = setTimeout(
        () => fail(new ClamdError('timeout', 'Timed out connecting to clamd')),
        Math.min(this.options.connectTimeoutMs, deadlineMs),
      );
      const deadline = setTimeout(() => fail(new ClamdError('timeout', 'clamd did not answer in time')), deadlineMs);

      socket.on('data', (data: Buffer) => {
        if (done) return;
        received = Buffer.concat([received, data]);
        const end = received.indexOf(0);
        if (end >= 0) {
          settle({ value: received.subarray(0, end).toString('utf8') });
          return;
        }
        if (received.length > MAX_REPLY_BYTES) fail(new ClamdError('protocol_error', 'clamd reply is too long'));
      });
      socket.on('error', () => {
        fail(new ClamdError(connected ? 'connection_closed' : 'connect_failed', connected
          ? 'The clamd connection failed'
          : 'Could not connect to clamd'));
      });
      socket.on('close', () => {
        // clamd closes after replying; a reply without its NUL still counts.
        if (!done && received.length > 0) settle({ value: received.toString('utf8') });
        fail(new ClamdError(connected ? 'connection_closed' : 'connect_failed', 'clamd closed the connection without a reply'));
      });
      socket.once('connect', () => {
        clearTimeout(connectTimer);
        if (done) return;
        connected = true;
        resolveOpen({
          socket,
          reply,
          settled: () => done,
          fail,
          close: () => {
            clearTimeout(connectTimer);
            clearTimeout(deadline);
            done = true;
          },
        });
      });
    });
  }

  /** Writes with backpressure; returns early (without error) once the exchange has settled. */
  private async write(exchange: Exchange, data: Buffer): Promise<void> {
    if (exchange.settled()) return;
    const { socket } = exchange;
    if (socket.write(data)) return;
    await new Promise<void>(resolve => {
      const finish = () => {
        socket.off('drain', finish);
        socket.off('close', finish);
        clearInterval(poll);
        resolve();
      };
      // The reply or a failure settles the exchange without a drain.
      const poll = setInterval(() => {
        if (exchange.settled()) finish();
      }, 50);
      socket.on('drain', finish);
      socket.on('close', finish);
    });
  }
}
