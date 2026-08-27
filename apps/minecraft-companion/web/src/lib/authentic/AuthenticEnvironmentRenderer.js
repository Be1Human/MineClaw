import * as THREE from 'three';

const DIMENSIONS = {
  overworld: { day: 0x86b8e7, night: 0x071326, fog: 0x90a9bf, light: 1 },
  the_nether: { day: 0x3a0b06, night: 0x160403, fog: 0x5a130b, light: 0.32 },
  the_end: { day: 0x171029, night: 0x090710, fog: 0x2b2044, light: 0.5 },
};

export class AuthenticEnvironmentRenderer {
  constructor({ scene, config } = {}) {
    this.scene = scene;
    this.config = config;
    this.active = false;
    this.environment = null;
    this.center = { chunkX: 0, chunkZ: 0 };
    this.originalBackground = null;
    this.originalFog = null;
    this.originalLightIntensities = new Map();
    this.rain = null;
  }

  activate(environment, center) {
    if (!this.active) {
      this.originalBackground = this.scene.background;
      this.originalFog = this.scene.fog;
      this.originalLightIntensities.clear();
      this.scene.traverse(object => {
        if (object.isLight) this.originalLightIntensities.set(object, object.intensity);
      });
    }
    this.active = true;
    this.update(environment, center);
  }

  update(environment, center = this.center) {
    if (!this.active || !environment) return;
    this.environment = environment;
    this.center = center ?? this.center;
    const dimension = dimensionStyle(environment.dimension);
    const daylight = daylightFactor(environment.timeOfDay);
    const thunder = THREE.MathUtils.clamp(Number(environment.thunderState ?? 0), 0, 1);
    this.scene.background = new THREE.Color(dimension.night).lerp(new THREE.Color(dimension.day), daylight).multiplyScalar(1 - thunder * 0.35);
    const fogColor = new THREE.Color(dimension.fog).lerp(this.scene.background, 0.45);
    const densityKey = dimensionKey(environment.dimension);
    const baseDensity = this.config.fogDensity?.[densityKey] ?? this.config.fogDensity?.overworld ?? 0.004;
    const density = baseDensity * (environment.isRaining ? this.config.rainFogMultiplier : 1);
    this.scene.fog = new THREE.FogExp2(fogColor, density);
    for (const [light, original] of this.originalLightIntensities) {
      light.intensity = original * dimension.light * (0.25 + daylight * 0.75)
        * (environment.isRaining ? 0.72 : 1) * (1 - thunder * 0.45);
    }
    if (this.rain && (this.rain.geometry.attributes.position.count !== Math.max(0, Math.floor(this.config.weatherParticleCount))
      || this.rain.userData.radius !== this.config.weatherRadius)) {
      this.removeRain();
    }
    if (environment.isRaining) this.ensureRain();
    else this.removeRain();
    this.positionRain();
  }

  tick(deltaSeconds = 1 / 60) {
    if (!this.active || !this.rain) return;
    const positions = this.rain.geometry.attributes.position;
    const radius = this.config.weatherRadius;
    for (let index = 1; index < positions.count * 3; index += 3) {
      positions.array[index] -= this.config.weatherFallSpeed * deltaSeconds;
      if (positions.array[index] < 0) positions.array[index] += radius * 1.6;
    }
    positions.needsUpdate = true;
  }

  ensureRain() {
    if (this.rain) return;
    const count = Math.max(0, Math.floor(this.config.weatherParticleCount));
    const radius = this.config.weatherRadius;
    const positions = new Float32Array(count * 3);
    let seed = 0x51f15e;
    for (let index = 0; index < count; index++) {
      seed = pseudoRandom(seed); positions[index * 3] = (seed / 0xffffffff * 2 - 1) * radius;
      seed = pseudoRandom(seed); positions[index * 3 + 1] = seed / 0xffffffff * radius * 1.6;
      seed = pseudoRandom(seed); positions[index * 3 + 2] = (seed / 0xffffffff * 2 - 1) * radius;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color: 0xa9cced, size: 0.07, transparent: true, opacity: 0.62, depthWrite: false });
    this.rain = new THREE.Points(geometry, material);
    this.rain.name = 'authenticWeather';
    this.rain.userData.radius = radius;
    this.scene.add(this.rain);
  }

  positionRain() {
    if (!this.rain) return;
    this.rain.position.set(this.center.chunkX * 16 + 8, 0, this.center.chunkZ * 16 + 8);
  }

  removeRain() {
    if (!this.rain) return;
    this.scene.remove(this.rain);
    this.rain.geometry.dispose();
    this.rain.material.dispose();
    this.rain = null;
  }

  deactivate() {
    if (!this.active) return;
    this.removeRain();
    this.scene.background = this.originalBackground;
    this.scene.fog = this.originalFog;
    for (const [light, intensity] of this.originalLightIntensities) light.intensity = intensity;
    this.originalLightIntensities.clear();
    this.environment = null;
    this.active = false;
  }

  dispose() { this.deactivate(); }
}

function dimensionStyle(dimension = '') { return DIMENSIONS[normalizeDimension(dimension)] ?? DIMENSIONS.overworld; }
function dimensionKey(dimension = '') {
  const normalized = normalizeDimension(dimension);
  return normalized === 'the_nether' ? 'theNether' : normalized === 'the_end' ? 'theEnd' : 'overworld';
}
function normalizeDimension(dimension) { return String(dimension).replace(/^minecraft:/, '').toLowerCase(); }
function daylightFactor(timeOfDay) {
  const angle = (Number(timeOfDay ?? 0) / 24000) * Math.PI * 2;
  return THREE.MathUtils.clamp((Math.cos(angle) + 0.28) / 1.28, 0.05, 1);
}
function pseudoRandom(seed) { return (Math.imul(seed, 1664525) + 1013904223) >>> 0; }
