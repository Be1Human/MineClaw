import net from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readServerProperties(serverDir) {
  const text = readFileSync(resolve(serverDir, 'server.properties'), 'utf8').replace(/^\uFEFF/, '');
  return Object.fromEntries(text.split(/\r?\n/).flatMap(rawLine => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return [];
    const separator = line.indexOf('=');
    if (separator < 0) return [];
    return [[line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/\\:/g, ':')]];
  }));
}

export async function executeLocalRcon({ serverDir, commands, timeoutMs = 8_000 }) {
  if (!Array.isArray(commands) || commands.length === 0) return [];
  const properties = readServerProperties(serverDir);
  if (properties['enable-rcon'] !== 'true') throw new Error('RCON is not enabled');
  const password = properties['rcon.password'];
  const port = Number(properties['rcon.port'] || 25575);
  if (!password) throw new Error('RCON password is missing');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RCON port');

  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0);
    let authenticated = false;
    let commandIndex = 0;
    let settled = false;
    const responses = [];

    const finish = error => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(responses);
    };
    const sendNext = () => {
      if (commandIndex >= commands.length) return finish();
      socket.write(encodePacket(100 + commandIndex, 2, commands[commandIndex]));
    };

    socket.setTimeout(timeoutMs, () => finish(new Error('RCON timeout')));
    socket.on('connect', () => socket.write(encodePacket(1, 3, password)));
    socket.on('error', error => finish(new Error(`RCON connection failed: ${error.message}`)));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readInt32LE(0);
        if (length < 10 || buffer.length < length + 4) return;
        const packet = buffer.subarray(0, length + 4);
        buffer = buffer.subarray(length + 4);
        const id = packet.readInt32LE(4);
        const body = packet.subarray(12, length + 2).toString('utf8').trim();
        if (!authenticated) {
          if (id === -1) return finish(new Error('RCON authentication failed'));
          if (id !== 1) continue;
          authenticated = true;
          sendNext();
          continue;
        }
        const expectedId = 100 + commandIndex;
        if (id !== expectedId) continue;
        responses.push({ command: commands[commandIndex], response: body });
        commandIndex += 1;
        sendNext();
      }
    });
  });
}

function encodePacket(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const length = 4 + 4 + payload.length + 2;
  const packet = Buffer.alloc(length + 4);
  packet.writeInt32LE(length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  return packet;
}
