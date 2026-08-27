import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { Server as SocketIOServer } from 'socket.io';

const requireFromWeb = createRequire(new URL('../../../../apps/minecraft-companion/web/package.json', import.meta.url));
const { io: createClient } = requireFromWeb('socket.io-client') as {
  io: (url: string, options: Record<string, unknown>) => {
    once(event: string, listener: (...args: unknown[]) => void): void;
    close(): void;
  };
};

test('FEAT-WEBUI-27-002 | Socket.IO 保留 section Uint16/Uint8 二进制附件', async () => {
  const http = createServer();
  const io = new SocketIOServer(http);
  io.on('connection', socket => {
    socket.emit('visual-bootstrap', {
      indices: new Uint16Array([1, 257, 4095]),
      light: new Uint8Array([0, 7, 15]),
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  const client = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  try {
    const payload = await new Promise<{ indices: Uint8Array; light: Uint8Array }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('visual bootstrap timeout')), 3_000);
      client.once('visual-bootstrap', (value: unknown) => {
        clearTimeout(timeout);
        resolve(value as { indices: Uint8Array; light: Uint8Array });
      });
    });
    const indices = new Uint16Array(
      payload.indices.buffer,
      payload.indices.byteOffset,
      payload.indices.byteLength / Uint16Array.BYTES_PER_ELEMENT,
    );
    assert.deepEqual(Array.from(indices), [1, 257, 4095]);
    assert.deepEqual(Array.from(payload.light), [0, 7, 15]);
  } finally {
    client.close();
    await io.close();
    if (http.listening) await new Promise<void>(resolve => http.close(() => resolve()));
  }
});
