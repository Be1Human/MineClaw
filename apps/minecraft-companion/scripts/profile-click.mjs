// [TEMP] 程序化点击某按钮并采样，定位交互卡顿。
// 用法: node scripts/profile-click.mjs "按钮文字"
const PORT = 9222;
const BTN_TEXT = process.argv[2] || '开启 3D 感知';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rpc(ws){let id=0;const p=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){const{r,j}=p.get(m.id);p.delete(m.id);m.error?j(new Error(JSON.stringify(m.error))):r(m.result);}});return(method,params={})=>new Promise((r,j)=>{const i=++id;p.set(i,{r,j});ws.send(JSON.stringify({id:i,method,params}));});}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find(t=>t.type==='page')||targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j);});
const send = rpc(ws);
await send('Runtime.enable');
await send('Profiler.enable');
await send('Profiler.setSamplingInterval',{interval:150});
await send('Profiler.start');

// 点击：找到包含指定文字的可点元素并 .click()
const clickRes = await send('Runtime.evaluate',{expression:`(() => {
  const all=[...document.querySelectorAll('button, [role=button], div, span, a')];
  const el=all.find(e=>e.innerText && e.innerText.trim()===${JSON.stringify(BTN_TEXT)})
        || all.find(e=>e.innerText && e.innerText.includes(${JSON.stringify(BTN_TEXT)}) && e.offsetParent);
  if(!el) return 'NOT_FOUND';
  el.scrollIntoView(); el.click();
  return 'clicked: '+el.tagName+' "'+el.innerText.trim().slice(0,30)+'"';
})()`,returnByValue:true});
console.log('点击结果:', clickRes.result?.result?.value);

await sleep(6000);
const {profile} = await send('Profiler.stop');
ws.close();

const shorten=u=>!u?'(native)':u.replace(/^https?:\/\/[^/]+\//,'/').replace(/\?.*$/,'');
const self=new Map();let total=0;
for(const n of profile.nodes){const f=n.callFrame;const k=`${f.functionName||'(anon)'}  @ ${shorten(f.url)}:${f.lineNumber+1}`;self.set(k,(self.get(k)||0)+(n.hitCount||0));total+=n.hitCount||0;}
let maxGap=0;for(const d of (profile.timeDeltas||[])) if(d>maxGap) maxGap=d;
console.log(`\n采样点 ${total} · 最长单帧间隔 ${(maxGap/1000).toFixed(0)}ms（>1000=卡顿）\n=== 自耗时 Top 20 ===`);
for(const [k,v] of [...self.entries()].sort((a,b)=>b[1]-a[1]).slice(0,20)) console.log(`${((v/total)*100).toFixed(1).padStart(5)}%  ${k}`);
