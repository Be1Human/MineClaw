/**
 * 健身房 harness · 极简 RCON 客户端（Source RCON 协议，长连接 + 串行队列）
 * 对应 D:\mc-test-server（enable-rcon=true, port 25575）
 */
import net from 'net';

export class Rcon {
  private sock: net.Socket | null = null;
  private acc = Buffer.alloc(0);
  private nextId = 10;
  private pending: Array<{ id: number; resolve: (s: string) => void; timer: NodeJS.Timeout }> = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private host = '127.0.0.1',
    private port = 25575,
    private pass = 'clawtest',
  ) {}

  private pkt(id: number, type: number, body: string): Buffer {
    const b = Buffer.from(body, 'utf8');
    const len = 4 + 4 + b.length + 2;
    const buf = Buffer.alloc(4 + len);
    buf.writeInt32LE(len, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    b.copy(buf, 12);
    return buf;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(this.port, this.host);
      this.sock = sock;
      const authTimer = setTimeout(() => reject(new Error('RCON 连接/认证超时')), 8000);
      sock.once('connect', () => sock.write(this.pkt(1, 3, this.pass)));
      let authed = false;
      sock.on('data', (d) => {
        // Socket 可在调用方设置编码后传入 string；RCON 协议按字节解析，
        // 因此在边界统一收敛为 Buffer，避免把字符串传给 Buffer.concat。
        const chunk = typeof d === 'string' ? Buffer.from(d, 'utf8') : d;
        this.acc = Buffer.concat([this.acc, chunk]);
        while (this.acc.length >= 4) {
          const len = this.acc.readInt32LE(0);
          if (this.acc.length < 4 + len) break;
          const id = this.acc.readInt32LE(4);
          const body = this.acc.slice(12, 4 + len - 2).toString('utf8');
          this.acc = this.acc.slice(4 + len);
          if (!authed) {
            clearTimeout(authTimer);
            if (id === -1) { reject(new Error('RCON 认证失败')); return; }
            authed = true;
            resolve();
            continue;
          }
          const i = this.pending.findIndex(p => p.id === id);
          if (i >= 0) {
            const [p] = this.pending.splice(i, 1);
            clearTimeout(p.timer);
            p.resolve(body);
          }
        }
      });
      sock.on('error', (e) => { clearTimeout(authTimer); reject(e); });
    });
  }

  /** 串行发命令（不带前导 /），返回服务器回显文本 */
  send(command: string, timeoutMs = 8000): Promise<string> {
    const run = async (): Promise<string> => {
      if (!this.sock) throw new Error('RCON 未连接');
      const id = this.nextId++;
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          const i = this.pending.findIndex(p => p.id === id);
          if (i >= 0) this.pending.splice(i, 1);
          resolve('(RCON 超时无回显)');
        }, timeoutMs);
        this.pending.push({ id, resolve, timer });
        this.sock!.write(this.pkt(id, 2, command));
      });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  close(): void {
    try { this.sock?.destroy(); } catch { /* ignore */ }
    this.sock = null;
  }
}
