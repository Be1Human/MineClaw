import { createHash } from 'node:crypto';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

const JAVA_LAN_MULTICAST_ADDRESS = '224.0.2.60';
const JAVA_LAN_MULTICAST_PORT = 4445;
const MAX_MOTD_CHARS = 240;

export interface DiscoveredLanWorld {
  id: string;
  motd: string;
  host: string;
  port: number;
  lastSeenAt: number;
}

export interface LanWorldDiscoverySnapshot {
  state: 'idle' | 'listening' | 'unavailable';
  worlds: DiscoveredLanWorld[];
  error?: string;
}

export interface LanWorldDiscoveryPort {
  start(): Promise<void>;
  stop(): void;
  snapshot(): LanWorldDiscoverySnapshot;
  get(worldId: string): DiscoveredLanWorld | undefined;
  subscribe(listener: (snapshot: LanWorldDiscoverySnapshot) => void): () => void;
}

export interface ParsedJavaLanAnnouncement {
  motd: string;
  port: number;
}

export function parseJavaLanAnnouncement(payload: Uint8Array | string): ParsedJavaLanAnnouncement | null {
  const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
  const motdStart = text.indexOf('[MOTD]');
  const motdEnd = text.indexOf('[/MOTD]', motdStart + 6);
  const addressStart = text.indexOf('[AD]', motdEnd + 7);
  const addressEnd = text.indexOf('[/AD]', addressStart + 4);
  if (motdStart < 0 || motdEnd < 0 || addressStart < 0 || addressEnd < 0) return null;
  if (motdStart > motdEnd || motdEnd > addressStart || addressStart > addressEnd) return null;

  const rawPort = text.slice(addressStart + 4, addressEnd).trim();
  if (!/^\d{1,5}$/.test(rawPort)) return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const motd = text
    .slice(motdStart + 6, motdEnd)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MOTD_CHARS);
  return { motd: motd || 'Minecraft LAN World', port };
}

function worldId(host: string, port: number): string {
  return createHash('sha256').update(`${host}:${port}`).digest('hex').slice(0, 20);
}

function cloneWorld(world: DiscoveredLanWorld): DiscoveredLanWorld {
  return { ...world };
}

export class LanWorldRegistry {
  private readonly worlds = new Map<string, DiscoveredLanWorld>();

  observe(host: string, announcement: ParsedJavaLanAnnouncement, at = Date.now()): DiscoveredLanWorld | null {
    if (isIP(host) !== 4) return null;
    const id = worldId(host, announcement.port);
    const world: DiscoveredLanWorld = {
      id,
      host,
      port: announcement.port,
      motd: announcement.motd,
      lastSeenAt: at,
    };
    this.worlds.set(id, world);
    return cloneWorld(world);
  }

  list(): DiscoveredLanWorld[] {
    return Array.from(this.worlds.values(), cloneWorld)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.id.localeCompare(right.id));
  }

  get(id: string): DiscoveredLanWorld | undefined {
    const world = this.worlds.get(id);
    return world ? cloneWorld(world) : undefined;
  }
}

export interface JavaLanWorldDiscoveryOptions {
  now?: () => number;
  socketFactory?: () => Socket;
  interfaceAddresses?: () => string[];
}

function discoverableIpv4Addresses(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.add(entry.address);
    }
  }
  return [...addresses];
}

export class JavaLanWorldDiscovery implements LanWorldDiscoveryPort {
  private readonly registry = new LanWorldRegistry();
  private readonly listeners = new Set<(snapshot: LanWorldDiscoverySnapshot) => void>();
  private readonly now: () => number;
  private readonly socketFactory: () => Socket;
  private readonly interfaceAddresses: () => string[];
  private socket: Socket | null = null;
  private startPromise: Promise<void> | null = null;
  private state: LanWorldDiscoverySnapshot['state'] = 'idle';
  private error: string | undefined;

  constructor(options: JavaLanWorldDiscoveryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.socketFactory = options.socketFactory ?? (() => createSocket({ type: 'udp4', reuseAddr: true }));
    this.interfaceAddresses = options.interfaceAddresses ?? discoverableIpv4Addresses;
  }

  start(): Promise<void> {
    if (this.state === 'listening') return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise(resolve => {
      const socket = this.socketFactory();
      this.socket = socket;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.startPromise = null;
        resolve();
      };

      socket.on('message', (payload: Buffer, remote: RemoteInfo) => {
        const announcement = parseJavaLanAnnouncement(payload);
        if (!announcement) return;
        const observed = this.registry.observe(remote.address, announcement, this.now());
        if (observed) this.publish();
      });
      socket.on('error', error => {
        if (this.socket !== socket) {
          finish();
          return;
        }
        this.state = 'unavailable';
        this.error = error.message;
        this.publish();
        try { socket.close(); } catch { /* already closed */ }
        if (this.socket === socket) this.socket = null;
        finish();
      });
      socket.once('close', finish);
      socket.once('listening', () => {
        if (this.socket !== socket) {
          finish();
          return;
        }
        let memberships = 0;
        for (const address of this.interfaceAddresses()) {
          try {
            socket.addMembership(JAVA_LAN_MULTICAST_ADDRESS, address);
            memberships += 1;
          } catch { /* try remaining interfaces */ }
        }
        if (memberships === 0) {
          try {
            socket.addMembership(JAVA_LAN_MULTICAST_ADDRESS);
            memberships = 1;
          } catch (error) {
            this.state = 'unavailable';
            this.error = error instanceof Error ? error.message : String(error);
            this.publish();
            try { socket.close(); } catch { /* already closed */ }
            if (this.socket === socket) this.socket = null;
            finish();
            return;
          }
        }
        this.state = 'listening';
        this.error = undefined;
        this.publish();
        finish();
      });

      try {
        socket.bind(JAVA_LAN_MULTICAST_PORT);
      } catch (error) {
        this.state = 'unavailable';
        this.error = error instanceof Error ? error.message : String(error);
        this.publish();
        try { socket.close(); } catch { /* never opened */ }
        if (this.socket === socket) this.socket = null;
        finish();
      }
    });
    return this.startPromise;
  }

  stop(): void {
    const socket = this.socket;
    this.socket = null;
    this.startPromise = null;
    if (socket) {
      try { socket.close(); } catch { /* already closed */ }
    }
    if (this.state !== 'idle' || this.error) {
      this.state = 'idle';
      this.error = undefined;
      this.publish();
    }
  }

  snapshot(): LanWorldDiscoverySnapshot {
    return {
      state: this.state,
      worlds: this.registry.list(),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  get(id: string): DiscoveredLanWorld | undefined {
    return this.registry.get(id);
  }

  subscribe(listener: (snapshot: LanWorldDiscoverySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* isolate observers from the UDP listener */ }
    }
  }
}
