#!/usr/bin/env node
// UTF-8 安全的 owner 喊话器（避免 curl/git-bash 把中文 JSON body 搞成乱码）
// 用法: node scripts/mc-chat.mjs "走到坐标 63 -60 41"
import http from 'node:http';
const msg = process.argv[2];
const botId = process.argv[3] ?? '1dfb86f0-e5b8-452d-923c-3c09aa6c9267';
if (!msg) { console.error('用法: node scripts/mc-chat.mjs "<消息>" [botId]'); process.exit(1); }
const body = Buffer.from(JSON.stringify({ message: msg, sender: 'cloudboyboy' }), 'utf8');
const req = http.request({
  host: '127.0.0.1', port: 3000, path: `/api/bots/${botId}/chat`, method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length },
}, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => console.log('reply:', d)); });
req.on('error', e => { console.error('err:', e.message); process.exit(1); });
req.write(body); req.end();
