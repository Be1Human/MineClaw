import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { JavaLanWorldDiscovery } from '../../../apps/minecraft-companion/src/hub/lanWorldDiscovery.js';

const multicastAddress = '224.0.2.60';
const multicastPort = 4445;
const announcedPort = 51234;
const motd = `MineClaw smoke ${Date.now()}`;
const payload = Buffer.from(`[MOTD]${motd}[/MOTD][AD]${announcedPort}[/AD]`);
const discovery = new JavaLanWorldDiscovery();
const sender = createSocket('udp4');

async function waitForCandidate(timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = discovery.snapshot().worlds.find(world => world.motd === motd);
    if (candidate) return candidate;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Java LAN multicast smoke timed out: ${JSON.stringify(discovery.snapshot())}`);
}

try {
  await discovery.start();
  assert.equal(discovery.snapshot().state, 'listening');
  await new Promise<void>((resolve, reject) => {
    sender.once('error', reject);
    sender.bind(0, () => {
      sender.setMulticastTTL(1);
      sender.setMulticastLoopback(true);
      sender.send(payload, multicastPort, multicastAddress, error => error ? reject(error) : resolve());
    });
  });
  const candidate = await waitForCandidate();
  assert.equal(candidate.port, announcedPort);
  assert.equal(candidate.motd, motd);
  console.log(JSON.stringify({ state: discovery.snapshot().state, candidate }, null, 2));
} finally {
  sender.close();
  discovery.stop();
}

