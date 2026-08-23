#!/usr/bin/env node
/** rcon-cmd.mjs · 通用 RCON 发送器。用法: node scripts/rcon-cmd.mjs "/cmd1" "/cmd2" ... */
import net from 'node:net';
const HOST = process.env.RC_HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.RC_PORT ?? '25575', 10);
const PASS = process.env.RC_PASS ?? 'clawtest';
const cmds = process.argv.slice(2);
function pkt(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const len = 10 + b.length;
  const p = Buffer.alloc(4 + len);
  p.writeInt32LE(len, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8);
  b.copy(p, 12); return p;
}
const sock = net.connect(PORT, HOST, () => sock.write(pkt(1, 3, PASS)));
let q = [...cmds], authed = false;
sock.on('data', (d) => {
  const id = d.readInt32LE(4);
  const body = d.slice(12, d.length - 2).toString('utf8').trim();
  if (!authed) {
    if (id === -1) { console.error('❌ RCON 认证失败'); process.exit(2); }
    authed = true; next();
    return;
  }
  if (body) console.log('  <srv>', body);
  next();
});
function next() {
  if (q.length === 0) { setTimeout(() => process.exit(0), 200); return; }
  sock.write(pkt(2, 2, q.shift()));
}
sock.on('error', (e) => { console.error('RCON err:', e.message); process.exit(3); });
sock.setTimeout(15000, () => { console.error('RCON 超时'); process.exit(4); });
