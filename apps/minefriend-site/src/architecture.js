import './style.css';
import './architecture.css';
import {
  coreNodes,
  entryNodes,
  executionNodes,
  gateItems,
  roundSteps,
  sourceLedger,
  supportPlanes,
} from './architecture-data.js';

document.documentElement.classList.add('js');

const nodeCard = (node, extra = '') => `
  <article class="architecture-node ${extra}" data-aspect="${node.aspect}">
    ${node.index ? `<span class="node-index">${node.index}</span>` : ''}
    <div><h3>${node.title}</h3><p>${node.subtitle || node.caption}</p></div>
    ${node.detail ? `<p class="node-detail">${node.detail}</p>` : ''}
    ${node.source ? `<code>${node.source}</code>` : ''}
  </article>`;

const app = document.querySelector('#app');

app.innerHTML = `
  <header class="architecture-header">
    <a class="brand" href="./" aria-label="返回 MineClaw 宣传首页">
      <img class="brand-mark" src="./brand/mineclaw-mark.svg" alt="" aria-hidden="true" />
      <span class="brand-copy"><strong>MineClaw</strong><small>IMPLEMENTATION ARCHITECTURE</small></span>
    </a>
    <nav aria-label="架构页导航"><a href="#system">系统图</a><a href="#sources">源码映射</a><a href="./">返回首页</a></nav>
  </header>

  <main>
    <section class="architecture-hero">
      <div class="architecture-grid" aria-hidden="true"></div>
      <div class="architecture-hero-copy">
        <p class="architecture-kicker"><i></i> CURRENT PUBLIC / MAIN · CODE-MAPPED</p>
        <h1>不是概念图。<br /><em>这是 MineClaw 现在如何运行。</em></h1>
        <p>从玩家的一句话，到伙伴在 Minecraft 世界里行动，再到每次工具调用和世界结果都能被回看——下面每个核心节点都对应当前仓库中的真实实现。</p>
        <div class="truth-chips"><span>连续 Agent Loop</span><span>唯一执行边界</span><span>机器验真</span><span>追加式事件账本</span></div>
      </div>
      <aside class="architecture-hero-aside"><strong>READING GUIDE</strong><span>01 · 输入进入伙伴大脑</span><span>02 · GoalAgent 持续调用工具</span><span>03 · 世界结果回到下一轮</span></aside>
    </section>

    <section class="architecture-system" id="system" aria-labelledby="system-title">
      <div class="architecture-section-heading">
        <div><p>01 / END-TO-END SYSTEM</p><h2 id="system-title">一条从目标到世界事实的完整链路</h2></div>
        <div class="focus-switch" role="group" aria-label="突出显示架构关注面">
          <button type="button" data-focus-button="all" aria-pressed="true">全部</button>
          <button type="button" data-focus-button="cognition" aria-pressed="false">认知</button>
          <button type="button" data-focus-button="execution" aria-pressed="false">执行</button>
          <button type="button" data-focus-button="evidence" aria-pressed="false">证据</button>
        </div>
      </div>

      <div class="system-map">
        <svg class="flow-lines" viewBox="0 0 1200 1110" aria-hidden="true">
          <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10Z" /></marker></defs>
          <path d="M200 94H1000" /><path d="M600 150V240" /><path d="M600 365V450" /><path d="M600 715V802" /><path d="M120 920H1080" />
        </svg>

        <div class="entry-row" aria-label="输入入口">${entryNodes.map((node) => nodeCard(node, 'entry-node')).join('')}</div>
        <div class="core-chain">${coreNodes.map((node) => nodeCard(node, `core-node node-${node.id}`)).join('')}</div>

        <section class="round-loop" aria-labelledby="round-loop-title">
          <div class="round-loop-heading"><span>CONTINUOUS ROUND LOOP</span><h3 id="round-loop-title">不是固定状态机，而是结果驱动的下一轮</h3><p>每一轮模型读取当前会话，选择工具，接收真实结果，并把事件追加到账本；只要目标未满足，就带着新事实进入下一轮。</p></div>
          <div class="round-track">${roundSteps.map((step) => nodeCard(step, 'round-step')).join('')}<span class="round-return" aria-hidden="true">NEXT ROUND ↺</span></div>
        </section>

        <section class="runtime-gates" data-aspect="execution">
          <div><span>TOOL RUNTIME / HARNESS</span><h3>每次动作先过工程约束，再触碰世界</h3></div>
          <ul>${gateItems.map((item) => `<li>${item}</li>`).join('')}</ul>
        </section>

        <div class="execution-chain" aria-label="生产执行链">${executionNodes.map((node) => nodeCard(node, 'execution-node')).join('')}</div>
      </div>
    </section>

    <section class="support-section" aria-labelledby="support-title">
      <div class="architecture-section-heading"><div><p>02 / SUPPORT PLANES</p><h2 id="support-title">感知、记忆与证据贯穿每一轮</h2></div><p>这些不是末端外挂，而是持续为认知提供上下文、为执行提供反馈、为人类提供可追溯事实的横切平面。</p></div>
      <div class="support-grid">${supportPlanes.map((node) => nodeCard(node, 'support-node')).join('')}</div>
    </section>

    <section class="source-section" id="sources" aria-labelledby="sources-title">
      <div class="source-intro"><p>03 / SOURCE LEDGER</p><h2 id="sources-title">图上的核心节点，都能落回真实源码</h2><p>路径相对于 <code>apps/minecraft-companion</code>。公开页只展示结构与文件定位，不暴露运行配置、密钥、日志或私有数据。</p></div>
      <div class="source-ledger">${sourceLedger.map(([name, path], index) => `<article><span>${String(index + 1).padStart(2, '0')}</span><strong>${name}</strong><code>${path}</code></article>`).join('')}</div>
    </section>

    <section class="truth-boundary">
      <span>TRUTH BOUNDARY</span><h2>LLM 可以提出动作。<br />只有世界状态能证明动作完成。</h2>
      <p>工具结果、任务状态、检查点和事件账本共同构成证据链；宣传页不把规划文本当成执行成功，也不把离线状态包装成在线能力。</p>
      <a class="button button-primary" href="./#screens">查看当前真实界面 <span aria-hidden="true">→</span></a>
    </section>
  </main>

  <footer class="architecture-footer"><span>MineClaw · Implementation Architecture</span><a href="https://github.com/Be1Human/MineClaw" target="_blank" rel="noreferrer">GitHub Repository ↗</a></footer>
`;

const focusButtons = [...document.querySelectorAll('[data-focus-button]')];
focusButtons.forEach((button) => button.addEventListener('click', () => {
  const focus = button.dataset.focusButton;
  document.body.dataset.focus = focus;
  focusButtons.forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === button)));
}));
