// [TEMP] CDP CPU 火焰图。用法: node scripts/cpu-profile.mjs [秒]
const PORT = 9222;
const DUR = (Number(process.argv[2]) || 15) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rpc(ws){let id=0;const p=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){const{r,j}=p.get(m.id);p.delete(m.id);m.error?j(new Error(JSON.stringify(m.error))):r(m.result);}});return(method,params={})=>new Promise((r,j)=>{const i=++id;p.set(i,{r,j});ws.send(JSON.stringify({id:i,method,params}));});}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find(t=>t.type==='page')||targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j);});
const send = rpc(ws);
await send('Profiler.enable');
await send('Profiler.setSamplingInterval',{interval:200});
await send('Profiler.start');
console.log(`采样 ${DUR/1000}s … 现在狂点按钮！`);
await sleep(DUR);
const {profile} = await send('Profiler.stop');
ws.close();

const shorten=u=>!u?'(native)':u.replace(/^https?:\/\/[^/]+\//,'/').replace(/\?.*$/,'');
// 自耗时
const self=new Map();let total=0;
for(const n of profile.nodes){const f=n.callFrame;const k=`${f.functionName||'(anon)'}  @ ${shorten(f.url)}:${f.lineNumber+1}`;self.set(k,(self.get(k)||0)+(n.hitCount||0));total+=n.hitCount||0;}
// 总耗时(含子调用)：按样本时间线找最长连续阻塞
let maxGap=0;const td=profile.timeDeltas||[];for(const d of td) if(d>maxGap) maxGap=d;
console.log(`\n总采样点 ${total} · 时长 ${((profile.endTime-profile.startTime)/1e6).toFixed(1)}s · 最长单帧间隔 ${(maxGap/1000).toFixed(0)}ms（>1000ms=卡顿/同步阻塞）\n`);
console.log('=== 自耗时 Top 25 ===');
for(const [k,v] of [...self.entries()].sort((a,b)=>b[1]-a[1]).slice(0,25)) console.log(`${((v/total)*100).toFixed(1).padStart(5)}%  ${k}`);
