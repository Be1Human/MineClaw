import * as THREE from 'three';
import { PlayerObject } from 'skinview3d';
import { mineflayerYawToThreeRotation } from '../minecraftOrientation.js';

const DEFAULT_PLAYER_COLOR = 0x4f76b8;
const ITEM_COLOR = 0xf2cc60;
const DEFAULT_SKIN_URL = new URL('../../assets/skins/07-lanyi.png', import.meta.url).href;

export class AuthenticEntityRenderer {
  constructor({ group, config, imageFactory = defaultImageFactory, onDiagnostic = () => {} } = {}) {
    this.group = group;
    this.config = config;
    this.imageFactory = imageFactory;
    this.onDiagnostic = onDiagnostic;
    this.reportedPlaceholders = new Set();
    this.entries = new Map();
    this.geometries = new Set();
    this.materials = new Set();
  }

  sync(entities, center = { chunkX: 0, chunkZ: 0 }) {
    const selected = Array.from(entities?.values?.() ?? entities ?? [])
      .filter(entity => !entity.isSelf)
      .sort((left, right) => distanceFromCenter(left, center) - distanceFromCenter(right, center))
      .slice(0, this.config.maxAuthenticEntities);
    const retained = new Set(selected.map(entity => entity.id));
    for (const id of this.entries.keys()) if (!retained.has(id)) this.remove(id);
    for (const entity of selected) {
      let entry = this.entries.get(entity.id);
      if (!entry || entry.kind !== entityKind(entity)) {
        this.remove(entity.id);
        entry = this.create(entity);
        this.entries.set(entity.id, entry);
        this.group.add(entry.root);
      }
      entry.entity = entity;
      entry.target.set(entity.position.x, entity.position.y, entity.position.z);
      if (entry.kind !== 'item') {
        entry.root.rotation.y = mineflayerYawToThreeRotation(entity.yaw, entry.kind === 'player' ? '+z' : '-z');
      }
      entry.root.userData.entity = entity;
      this.updateEquipment(entry, entity);
    }
  }

  tick(deltaSeconds = 1 / 60) {
    const duration = Math.max(1, this.config.entityInterpolationMs) / 1000;
    const alpha = 1 - Math.exp(-Math.max(0, deltaSeconds) / duration);
    for (const entry of this.entries.values()) {
      entry.root.position.lerp(entry.target, alpha);
      if (entry.kind === 'item') {
        entry.root.rotation.y += deltaSeconds * 1.8;
        entry.root.position.y = entry.target.y + 0.18 + Math.sin(performanceNow() * 0.003 + entry.entity.id) * 0.08;
      } else if (entry.kind === 'player' && entry.player) {
        const moving = vectorLengthSq(entry.entity.velocity) > 0.0004;
        const swing = moving ? Math.sin(performanceNow() * 0.012) * 0.55 : 0;
        entry.player.skin.leftArm.rotation.x = swing;
        entry.player.skin.rightArm.rotation.x = -swing;
        entry.player.skin.leftLeg.rotation.x = -swing;
        entry.player.skin.rightLeg.rotation.x = swing;
        entry.player.skin.head.rotation.x = finite(entry.entity.pitch);
      }
    }
  }

  create(entity) {
    const kind = entityKind(entity);
    const root = new THREE.Group();
    root.name = `authenticEntity:${entity.id}:${entity.name}`;
    root.position.set(entity.position.x, entity.position.y, entity.position.z);
    const entry = { kind, root, target: root.position.clone(), entity, skinTexture: null, player: null, equipmentSignature: null, equipmentGroup: null };
    if (kind === 'player') this.addPlayer(entry, entity);
    else if (kind === 'item') this.addItem(entry, entity);
    else this.addMob(entry, entity);
    return entry;
  }

  addPlayer(entry, entity) {
    const fallback = this.blockyHumanoid(DEFAULT_PLAYER_COLOR, entity.height);
    fallback.name = 'fallbackPlayer';
    entry.root.add(fallback);
    const player = new PlayerObject();
    player.name = 'skinPlayer';
    player.scale.setScalar(Math.max(0.035, finite(entity.height, 1.8) / 36));
    player.position.y = finite(entity.height, 1.8) * 0.45;
    player.skin.visible = false;
    player.skin.modelType = entity.skinModel === 'slim' ? 'slim' : 'default';
    entry.player = player;
    entry.root.add(player);
    const skinSource = entity.skinUrl || DEFAULT_SKIN_URL;
    const image = this.imageFactory();
    if (!image) return;
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (this.entries.get(entity.id) !== entry) return;
      const texture = new THREE.CanvasTexture(image);
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.needsUpdate = true;
      entry.skinTexture?.dispose();
      entry.skinTexture = texture;
      player.skin.map = texture;
      player.skin.visible = true;
      fallback.visible = false;
    };
    image.onerror = () => {
      if (image.src !== DEFAULT_SKIN_URL) image.src = DEFAULT_SKIN_URL;
    };
    image.src = skinSource;
  }

  addMob(entry, entity) {
    const color = mobColor(entity.name);
    const height = Math.max(0.35, finite(entity.height, 1));
    const width = Math.max(0.25, finite(entity.width, 0.6));
    const humanoid = /zombie|skeleton|villager|witch|piglin|enderman|armor_stand/i.test(entity.name);
    if (!isKnownEntityName(entity.name) && !this.reportedPlaceholders.has(entity.name)) {
      this.reportedPlaceholders.add(entity.name);
      this.onDiagnostic({ type: 'entity-placeholder', entityId: entity.id, message: `暂用方块占位模型：${entity.name}` });
    }
    if (humanoid) {
      entry.root.add(this.blockyHumanoid(color, height));
      return;
    }
    const body = this.mesh(new THREE.BoxGeometry(width, height * 0.55, width * 1.35), color);
    body.position.y = height * 0.55;
    entry.root.add(body);
    const head = this.mesh(new THREE.BoxGeometry(width * 0.7, height * 0.38, width * 0.7), lighten(color));
    head.position.set(0, height * 0.75, -width * 0.8);
    entry.root.add(head);
    for (const x of [-0.28, 0.28]) for (const z of [-0.34, 0.34]) {
      const leg = this.mesh(new THREE.BoxGeometry(width * 0.2, height * 0.45, width * 0.2), darken(color));
      leg.position.set(x * width, height * 0.23, z * width);
      entry.root.add(leg);
    }
  }

  addItem(entry, entity) {
    const size = Math.max(0.18, Math.min(0.38, finite(entity.width, 0.25)));
    const mesh = this.mesh(new THREE.BoxGeometry(size, size, 0.05), itemColor(entity.itemName));
    mesh.rotation.x = -0.22;
    mesh.name = entity.itemName ? `item:${entity.itemName}` : 'item:unknown';
    entry.root.add(mesh);
  }

  updateEquipment(entry, entity) {
    if (entry.kind === 'item') return;
    const equipment = Array.from(entity.equipment ?? []);
    const signature = JSON.stringify(equipment);
    if (signature === entry.equipmentSignature) return;
    if (entry.equipmentGroup) {
      entry.root.remove(entry.equipmentGroup);
      this.disposeOwnedObject(entry.equipmentGroup);
    }
    entry.equipmentSignature = signature;
    const visible = equipment.map((name, slot) => ({ name, slot })).filter(item => item.name);
    if (!visible.length) {
      entry.equipmentGroup = null;
      return;
    }
    const height = Math.max(0.7, finite(entity.height, 1.8));
    const equipmentGroup = new THREE.Group();
    equipmentGroup.name = 'equipment';
    for (const { name, slot } of visible) {
      const armor = slot >= 2;
      const geometry = armor
        ? new THREE.BoxGeometry(slot === 5 ? 0.58 : 0.54, slot === 5 ? 0.34 : 0.22, slot === 5 ? 0.58 : 0.32)
        : new THREE.BoxGeometry(0.12, 0.52, 0.12);
      const marker = this.mesh(geometry, equipmentColor(name));
      marker.name = `equipment:${slot}:${name}`;
      if (slot === 0) marker.position.set(-0.43, height * 0.62, -0.12);
      else if (slot === 1) marker.position.set(0.43, height * 0.62, -0.12);
      else if (slot === 5) marker.position.set(0, height * 0.88, 0);
      else marker.position.set(0, height * (slot === 2 ? 0.18 : slot === 3 ? 0.4 : 0.62), 0);
      equipmentGroup.add(marker);
    }
    entry.equipmentGroup = equipmentGroup;
    entry.root.add(equipmentGroup);
  }

  blockyHumanoid(color, rawHeight) {
    const height = Math.max(0.7, finite(rawHeight, 1.8));
    const scale = height / 1.8;
    const root = new THREE.Group();
    const body = this.mesh(new THREE.BoxGeometry(0.5 * scale, 0.68 * scale, 0.25 * scale), color);
    body.position.y = 1.05 * scale;
    root.add(body);
    const head = this.mesh(new THREE.BoxGeometry(0.5 * scale, 0.5 * scale, 0.5 * scale), lighten(color));
    head.position.y = 1.64 * scale;
    root.add(head);
    for (const x of [-0.33, 0.33]) {
      const arm = this.mesh(new THREE.BoxGeometry(0.18 * scale, 0.68 * scale, 0.2 * scale), color);
      arm.position.set(x * scale, 1.05 * scale, 0);
      root.add(arm);
    }
    for (const x of [-0.14, 0.14]) {
      const leg = this.mesh(new THREE.BoxGeometry(0.22 * scale, 0.72 * scale, 0.22 * scale), darken(color));
      leg.position.set(x * scale, 0.36 * scale, 0);
      root.add(leg);
    }
    return root;
  }

  mesh(geometry, color) {
    const material = new THREE.MeshLambertMaterial({ color });
    this.geometries.add(geometry);
    this.materials.add(material);
    return new THREE.Mesh(geometry, material);
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.group.remove(entry.root);
    entry.skinTexture?.dispose();
    entry.player?.traverse(object => {
      object.geometry?.dispose?.();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material?.dispose?.();
    });
    this.disposeOwnedObject(entry.root);
    this.entries.delete(id);
  }

  disposeOwnedObject(root) {
    root.traverse(object => {
      if (object.geometry && this.geometries.has(object.geometry)) {
        object.geometry.dispose();
        this.geometries.delete(object.geometry);
      }
      if (object.material && this.materials.has(object.material)) {
        object.material.dispose();
        this.materials.delete(object.material);
      }
    });
  }

  dispose() {
    for (const id of Array.from(this.entries.keys())) this.remove(id);
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.clear();
    this.materials.clear();
  }
}

function entityKind(entity) {
  if (entity.itemName || entity.type === 'object' && /item/i.test(entity.name)) return 'item';
  if (entity.username || entity.type === 'player') return 'player';
  return 'mob';
}

function distanceFromCenter(entity, center) {
  const x = finite(entity.position?.x) - (finite(center?.chunkX) * 16 + 8);
  const z = finite(entity.position?.z) - (finite(center?.chunkZ) * 16 + 8);
  return x * x + z * z;
}

function mobColor(name = '') {
  if (/creeper/i.test(name)) return 0x54a83f;
  if (/zombie|slime/i.test(name)) return 0x4f8a55;
  if (/skeleton|ghast/i.test(name)) return 0xc9c9c2;
  if (/spider|wither/i.test(name)) return 0x332d35;
  if (/pig|axolotl/i.test(name)) return 0xe99ca7;
  if (/cow|horse/i.test(name)) return 0x795548;
  if (/enderman|dragon/i.test(name)) return 0x25142f;
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return 0x526b7a ^ (hash & 0x2f2f2f);
}

function itemColor(name = '') {
  if (/diamond/i.test(name)) return 0x55e6dc;
  if (/emerald/i.test(name)) return 0x32d56b;
  if (/gold/i.test(name)) return 0xf5c542;
  if (/redstone/i.test(name)) return 0xd13d32;
  return ITEM_COLOR;
}

function equipmentColor(name = '') {
  if (/diamond/i.test(name)) return 0x55d6d0;
  if (/netherite/i.test(name)) return 0x514657;
  if (/gold/i.test(name)) return 0xf1c84b;
  if (/iron|chainmail/i.test(name)) return 0xb8bec7;
  if (/leather|wood/i.test(name)) return 0x8a572f;
  return 0x9ca3af;
}

function isKnownEntityName(name = '') {
  return /allay|armor_stand|axolotl|bat|bee|blaze|bogged|breeze|camel|cat|cave_spider|chicken|cod|cow|creeper|dolphin|donkey|drowned|elder_guardian|enderman|endermite|ender_dragon|evoker|fox|frog|ghast|giant|glow_squid|goat|guardian|hoglin|horse|husk|illusioner|iron_golem|llama|magma_cube|mooshroom|mule|ocelot|panda|parrot|phantom|pig|piglin|pillager|polar_bear|pufferfish|rabbit|ravager|salmon|sheep|shulker|silverfish|skeleton|slime|sniffer|snow_golem|spider|squid|stray|strider|tadpole|trader_llama|tropical_fish|turtle|vex|villager|vindicator|wandering_trader|warden|witch|wither|wolf|zoglin|zombie|zombified_piglin/i.test(name);
}

function lighten(color) { return new THREE.Color(color).offsetHSL(0, 0, 0.12); }
function darken(color) { return new THREE.Color(color).offsetHSL(0, 0, -0.12); }
function finite(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function vectorLengthSq(vector) { return finite(vector?.x) ** 2 + finite(vector?.y) ** 2 + finite(vector?.z) ** 2; }
function performanceNow() { return globalThis.performance?.now?.() ?? Date.now(); }
function defaultImageFactory() { return typeof Image === 'undefined' ? null : new Image(); }
