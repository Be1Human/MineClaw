// 拉起第一个 profile 的 bot，等其上线后发送唤醒消息「来我这里」。
// 被 start.bat 调用，也可单独 `node scripts/wake-bot.js` 运行。
const http = require('http');

const HOST = 'localhost';
const PORT = 3000;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: HOST, port: PORT, path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    const profiles = await req('GET', '/api/profiles');
    if (!Array.isArray(profiles) || profiles.length === 0) {
      console.log('⚠️  未找到可用 profile，跳过。');
      return;
    }
    const profileId = profiles[0].id;
    const name = profiles[0].name || profileId;
    console.log(`🚀 启动 bot: ${name} (${profileId})`);
    await req('POST', `/api/bots/${profileId}/start`);

    // 等待上线（最多 ~20s）
    let online = false;
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const bots = await req('GET', '/api/bots');
      const b = Array.isArray(bots) ? bots.find((x) => x.profileId === profileId) : null;
      if (b && b.status === 'online') { online = true; break; }
    }
    if (!online) {
      console.log('   bot 尚未上线（可能账号被顶号或服务器拒连），跳过唤醒消息。');
      return;
    }

    const reply = await req('POST', `/api/bots/${profileId}/chat`, { message: '来我这里', sender: '主人' });
    console.log('   ✅ bot 已上线，已发送唤醒消息「来我这里」');
    console.log('   bot 回复:', reply && reply.reply ? reply.reply : JSON.stringify(reply));
  } catch (e) {
    console.log('   wake-bot 出错:', e.message);
  }
})();
