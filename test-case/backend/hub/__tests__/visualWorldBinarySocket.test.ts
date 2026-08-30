import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { Server as SocketIOServer } from 'socket.io';
import type { VisualWorldBootstrap, VisualSection } from '../../../../apps/minecraft-companion/src/bot/adapter/VisualWorldSource.js';
import type { VisualWorldDeltaBatch } from '../../../../apps/minecraft-companion/src/hub/visualWorldDeltaBatcher.js';
import {
  emitVisualWorldBootstrap,
  emitVisualWorldDeltaBatch,
  VISUAL_WORLD_BOOTSTRAP_END_EVENT,
  VISUAL_WORLD_BOOTSTRAP_SECTION_EVENT,
  VISUAL_WORLD_BOOTSTRAP_START_EVENT,
  VISUAL_WORLD_DELTA_END_EVENT,
  VISUAL_WORLD_DELTA_SECTION_EVENT,
  VISUAL_WORLD_DELTA_START_EVENT,
} from '../../../../apps/minecraft-companion/src/hub/visualWorldBootstrapEmitter.js';

const requireFromWeb = createRequire(new URL('../../../../apps/minecraft-companion/web/package.json', import.meta.url));
const { io: createClient } = requireFromWeb('socket.io-client') as {
  io: (url: string, options: Record<string, unknown>) => {
    on(event: string, listener: (...args: any[]) => void): void;
    connect(): void;
    close(): void;
  };
};

function section(index: number): VisualSection {
  return {
    key: `${index},-4,0`,
    chunkX: index,
    sectionY: -4,
    chunkZ: 0,
    palette: [{ stateId: 0, name: 'air', properties: {} }],
    indices: new Uint16Array([index, 257, 4095]),
    blockLight: new Uint8Array([0, 7, 15]),
    skyLight: new Uint8Array([15, 8, 0]),
    biomePalette: [{ id: 1, name: 'plains' }],
    biomeIndices: new Uint16Array([1, 1, 1]),
    nonAirBlocks: index,
  };
}

function bootstrap(): VisualWorldBootstrap {
  return {
    protocol: 'mineclaw.visual-world/v1',
    sessionId: 'socket-session',
    generation: 3,
    sequence: 12,
    gameVersion: '1.21.1',
    minY: -64,
    height: 384,
    center: { chunkX: 0, chunkZ: 0 },
    viewDistanceChunks: 2,
    sections: [section(0), section(1), section(2)],
    entities: [],
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false, thunderState: 0 },
    serverResourcePack: null,
    createdAt: Date.now(),
  };
}

function deltaBatch(): VisualWorldDeltaBatch {
  return {
    protocol: 'mineclaw.visual-world-delta/v1',
    sessionId: 'socket-session',
    generation: 3,
    fromSequence: 13,
    toSequence: 13,
    deltas: [{
      kind: 'column_replace',
      sessionId: 'socket-session',
      generation: 3,
      sequence: 13,
      timestamp: Date.now(),
      chunkX: 0,
      chunkZ: 0,
      sections: [section(0), section(1), section(2)],
    }],
    createdAt: Date.now(),
  };
}

test('BUG-WEBUI-23-002 | 三个 section 分包传输不超过 Socket.IO 附件上限且连接保持稳定', async () => {
  const http = createServer();
  const io = new SocketIOServer(http);
  io.on('connection', socket => {
    emitVisualWorldBootstrap(socket, 'bot-1', bootstrap());
    emitVisualWorldDeltaBatch(socket, 'bot-1', deltaBatch());
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  const client = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], autoConnect: false });
  try {
    const receivedSections: Array<{ index: number; section: { indices: Uint8Array; blockLight: Uint8Array } }> = [];
    const receivedDeltaSections: Array<{ index: number }> = [];
    let disconnected = false;
    let bootstrapEnded = false;
    const result = await new Promise<{ sectionCount: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('visual bootstrap timeout')), 3_000);
      client.on('disconnect', () => { disconnected = true; });
      client.on('connect_error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
      client.on(VISUAL_WORLD_BOOTSTRAP_START_EVENT, (value: { sectionCount: number }) => {
        assert.equal(value.sectionCount, 3);
      });
      client.on(VISUAL_WORLD_BOOTSTRAP_SECTION_EVENT, (value: typeof receivedSections[number]) => {
        receivedSections.push(value);
      });
      client.on(VISUAL_WORLD_BOOTSTRAP_END_EVENT, (value: { sectionCount: number }) => {
        bootstrapEnded = value.sectionCount === 3;
      });
      client.on(VISUAL_WORLD_DELTA_START_EVENT, (value: { sectionCount: number }) => {
        assert.equal(value.sectionCount, 3);
      });
      client.on(VISUAL_WORLD_DELTA_SECTION_EVENT, (value: { index: number }) => {
        receivedDeltaSections.push(value);
      });
      client.on(VISUAL_WORLD_DELTA_END_EVENT, (value: { sectionCount: number }) => {
        clearTimeout(timeout);
        resolve(value);
      });
      client.connect();
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(result.sectionCount, 3);
    assert.equal(bootstrapEnded, true);
    assert.equal(disconnected, false);
    assert.equal(receivedSections.length, 3);
    assert.equal(receivedDeltaSections.length, 3);
    const payload = receivedSections[2].section;
    const indicesBytes = Uint8Array.from(payload.indices);
    const indices = new Uint16Array(indicesBytes.buffer);
    assert.deepEqual(Array.from(indices), [2, 257, 4095]);
    assert.deepEqual(Array.from(payload.blockLight), [0, 7, 15]);
  } finally {
    client.close();
    await io.close();
    if (http.listening) await new Promise<void>(resolve => http.close(() => resolve()));
  }
});
