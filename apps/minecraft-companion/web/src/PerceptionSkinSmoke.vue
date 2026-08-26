<template>
  <div style="position:fixed;inset:0">
    <PerceptionScene3D :worldState="worldState" :skinTexture="skinTexture" :skinModel="skinModel" />
    <div style="position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:30;display:flex;gap:8px;padding:8px;background:#15170fee;border:2px solid #5d9c3c">
      <button data-testid="default-skin" @click="useDefault">蓝衣默认</button>
      <button data-testid="custom-skin" @click="useCustom">测试换肤</button>
      <button data-testid="turn-bot" @click="turn">转向 90°</button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import PerceptionScene3D from './components/PerceptionScene3D.vue';

localStorage.removeItem('perception3d_worldBlocks');

function makeTestSkin() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff2ca0';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#28e7ff';
  for (let y = 0; y < 64; y += 8) {
    for (let x = (y / 8) % 2 ? 0 : 8; x < 64; x += 16) ctx.fillRect(x, y, 8, 8);
  }
  return canvas.toDataURL('image/png');
}

const blocks = [];
for (let x = -6; x <= 6; x++) {
  for (let z = -6; z <= 6; z++) {
    blocks.push({
      name: (x + z) % 4 === 0 ? 'moss_block' : 'grass_block',
      category: 'solid',
      exposedAny: true,
      position: { x, y: 0, z },
    });
  }
}

const skinTexture = ref('');
const skinModel = ref('slim');
const worldState = ref({
  timestamp: Date.now(),
  self: {
    health: 20,
    maxHealth: 20,
    food: 20,
    position: { x: 0, y: 1, z: 0 },
    yaw: 0,
  },
  environment: { isDay: true, isRaining: false, dimension: 'overworld' },
  blocks,
  entities: [],
  threats: [],
  navigation: { hasGoal: false },
});

function useDefault() {
  skinTexture.value = '';
  skinModel.value = 'slim';
}

function useCustom() {
  skinTexture.value = makeTestSkin();
  skinModel.value = 'classic';
}

function turn() {
  worldState.value = {
    ...worldState.value,
    timestamp: Date.now(),
    self: { ...worldState.value.self, yaw: Math.PI / 2 },
  };
}
</script>
