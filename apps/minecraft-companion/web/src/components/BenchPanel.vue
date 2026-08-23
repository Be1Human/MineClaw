<template>
  <section style="flex:1; min-height:0; overflow:auto; padding:20px; background:#15170f; color:#e7e3d4;">
    <header style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
      <div><div style="font-weight:800; font-size:20px;">TestBench</div><div style="font-size:12px; color:#aab39b; margin-top:4px;">单次真服观测：摆场、执行、判定与轨迹</div></div>
      <button @click="refresh" style="padding:8px 12px; cursor:pointer; background:#4c7a2a; color:#fff; border:2px solid #223d13;">刷新</button>
    </header>
    <p v-if="!botId" style="color:#c9a25a;">请选择并启动一个伙伴后查看测试记录。</p>
    <template v-else>
      <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px;">
        <button v-for="card in cards" :key="card" @click="run(card)" style="padding:7px 10px; cursor:pointer; color:#dce8ce; background:#272d1d; border:1px solid #4f7d2e;">#test {{ card }}</button>
        <button @click="run('abort')" style="padding:7px 10px; cursor:pointer; color:#ffb4a8; background:#3a2420; border:1px solid #8c3a30;">中止</button>
      </div>
      <div style="display:grid; grid-template-columns:280px 1fr; gap:14px; min-height:360px;">
        <div style="border:2px solid #0c0e08; background:#1b1e14; overflow:auto;">
          <button v-for="run in runs" :key="run.runId" @click="loadTrace(run.runId)" :style="{display:'block',width:'100%',textAlign:'left',padding:'10px',cursor:'pointer',color:'#e7e3d4',background:selectedRun===run.runId?'#33451f':'transparent',border:'0',borderBottom:'1px solid #303726'}">
            <b>{{ run.cardId }}</b><br><small>{{ run.verdict?.status ?? 'running' }} · {{ new Date(run.startedAt).toLocaleTimeString() }}</small>
          </button>
          <p v-if="runs.length===0" style="padding:10px; color:#aab39b;">暂无运行记录</p>
        </div>
        <div style="border:2px solid #0c0e08; background:#10120c; overflow:auto; padding:10px;">
          <div v-for="lane in lanes" :key="lane" style="margin-bottom:10px;">
            <b :style="{color: laneColor(lane)}">{{ lane.toUpperCase() }}</b>
            <div v-for="event in grouped[lane]" :key="`${event.ts}-${event.type}`" style="margin:4px 0; padding:6px; background:#1b1e14; font-family:monospace; font-size:12px;">
              {{ new Date(event.ts).toLocaleTimeString() }} · {{ event.type }}
            </div>
          </div>
          <p v-if="trace.length===0" style="color:#aab39b;">选择一次运行查看五泳道轨迹。</p>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
const props = defineProps<{ botId?: string }>();
const runs = ref<any[]>([]); const trace = ref<any[]>([]); const selectedRun = ref('');
const cards = ['walk_to_10','dig_one','gather_1_log','craft_planks','gather_8_wood_clean','craft_wooden_pickaxe'];
const lanes = ['decision','task','strategy','execution','world','misc'];
const grouped = computed(() => Object.fromEntries(lanes.map(lane => [lane, trace.value.filter(event => (event.lane ?? 'misc') === lane)])));
const laneColor = (lane: string) => ({decision:'#9f7aea',task:'#60a5fa',strategy:'#fbbf24',execution:'#4ade80',world:'#fb7185',misc:'#aab39b'}[lane] ?? '#aab39b');
async function refresh() { if (!props.botId) return; const r = await fetch(`/api/bots/${props.botId}/v2/runs`); if (r.ok) runs.value = (await r.json()).runs ?? []; }
async function loadTrace(runId: string) { if (!props.botId) return; selectedRun.value = runId; const r = await fetch(`/api/bots/${props.botId}/v2/runs/${encodeURIComponent(runId)}`); if (r.ok) trace.value = (await r.json()).trace ?? []; }
async function run(card: string) { if (!props.botId) return; await fetch(`/api/bots/${props.botId}/chat`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:`#test ${card}`})}); setTimeout(refresh, 400); }
watch(() => props.botId, () => { trace.value=[]; selectedRun.value=''; void refresh(); }); onMounted(refresh);
</script>
