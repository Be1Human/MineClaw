import './style.css';

document.documentElement.classList.add('js');

const app = document.querySelector('#app');

app.innerHTML = `
  <header class="site-header" data-header>
    <a class="brand" href="#top" aria-label="MineClaw 首页">
      <img class="brand-mark" src="./brand/mineclaw-mark.svg" alt="" aria-hidden="true" />
      <span class="brand-copy"><strong>MineClaw</strong><small>A COMPANION WHO LIVES, PLAYS & GROWS WITH YOU</small></span>
    </a>
    <nav class="desktop-nav" aria-label="主导航">
      <a href="#why">她是谁</a>
      <a href="#life">我们的一天</a>
      <a href="#screens">真实世界</a>
      <a href="#demo">故事影像</a>
      <a href="./architecture.html">框架实现</a>
    </nav>
    <a class="header-cta" href="https://github.com/Be1Human/MineClaw" target="_blank" rel="noreferrer" aria-label="在新窗口打开 MineClaw GitHub 仓库">GitHub 仓库 <span aria-hidden="true">↗</span></a>
    <button class="nav-toggle" type="button" aria-label="展开导航" aria-expanded="false" data-nav-toggle>
      <span></span><span></span>
    </button>
    <nav class="mobile-nav" aria-label="移动端导航" data-mobile-nav>
      <a href="#why">她是谁</a>
      <a href="#life">我们的一天</a>
      <a href="#screens">真实世界</a>
      <a href="#demo">故事影像</a>
      <a href="./architecture.html">框架实现</a>
      <a href="https://github.com/Be1Human/MineClaw" target="_blank" rel="noreferrer">GitHub 仓库 ↗</a>
    </nav>
  </header>

  <main id="top">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-media" style="background-image: url('./media/ai-keyframes/05-finale-start.png?v=20260827-2205')" aria-hidden="true"></div>
      <div class="hero-veil" aria-hidden="true"></div>
      <div class="hero-grid" aria-hidden="true"></div>
      <p class="hero-concept"><i></i> AI STORY FRAME · CONCEPT RENDER</p>
      <div class="page-shell hero-content">
        <div class="hero-copy">
          <p class="eyebrow"><span class="eyebrow-dot"></span> A COMPANION WHO LIVES IN YOUR WORLD</p>
          <h1 id="hero-title">让伙伴，<br /><em>真正住进你的世界。</em></h1>
          <p class="hero-lead">
            陪你聊天、陪你玩，也真正走进 Minecraft，和你一起冒险、一起把事情做成。
          </p>
          <div class="hero-actions">
            <a class="button button-primary" href="#promo-video">观看宣传片 <span aria-hidden="true">→</span></a>
          </div>
        </div>
        <article class="hero-film media-slot" id="promo-video" data-media-key="overview" aria-label="MineClaw 主宣传片">
          <div class="hero-film-meta"><span><i></i> MINECLAW · PROMO FILM</span><small>01:30</small></div>
          <div class="media-placeholder hero-film-placeholder">
            <span class="media-state"><i></i> 宣传片预览</span>
            <span class="concept-badge">AI STORY FRAME · CONCEPT RENDER</span>
            <div class="media-play hero-film-play" aria-hidden="true">▶</div>
            <p>她走进世界，来到你身边。你们第一次面对面聊天，然后一起决定今天要去哪里。</p>
          </div>
          <div class="hero-film-caption"><strong>一个伙伴，真正走进我的世界</strong><span>相遇 · 陪伴 · 一起冒险</span></div>
        </article>
      </div>
      <div class="hero-scroll" aria-hidden="true"><span>SCROLL TO EXPLORE</span><i></i></div>
    </section>

    <section class="demo-section early-demo page-shell" id="demo" aria-labelledby="demo-title">
      <div class="section-index reveal">01 / WATCH THE STORY FIRST</div>
      <div class="demo-heading reveal">
        <div>
          <p class="section-kicker">同一个世界，接着发生的两个故事</p>
          <h2 id="demo-title">一起生活。<br />一起把事情做成。</h2>
        </div>
        <p>从晨光里的第一句话，到夜色中一起回家；从说出一个目标，到真实世界留下结果。</p>
      </div>

      <div class="media-grid supporting-media-grid">
        <article class="media-slot reveal" data-media-key="recovery">
          <div class="media-placeholder clay">
            <span class="media-state"><i></i> 故事预览</span>
            <span class="concept-badge">AI STORY FRAME · CONCEPT RENDER</span>
            <strong class="media-duration">00:45</strong>
            <div class="media-play" aria-hidden="true">▶</div>
            <p>晨光里聊天 → 一起准备营地与物资 → 穿过森林 → 走进矿洞 → 夜色中并肩回到家</p>
          </div>
          <div class="media-copy"><span>FILM 02</span><h3>我们一起度过 Minecraft 的一天</h3></div>
        </article>
        <article class="media-slot reveal" data-media-key="memory">
          <div class="media-placeholder amber">
            <span class="media-state"><i></i> 故事预览</span>
            <span class="concept-badge">AI STORY FRAME · CONCEPT RENDER</span>
            <strong class="media-duration">00:45</strong>
            <div class="media-play" aria-hidden="true">▶</div>
            <p>玩家说出目标 → MineClaw 的伙伴理解并规划 → 采集、制作或整理 → 遇阻调整 → 世界结果与共同完成画面</p>
          </div>
          <div class="media-copy"><span>FILM 03</span><h3>她不只听懂我，还能和我一起把事做成</h3></div>
        </article>
      </div>
    </section>

    <section class="belief page-shell" id="why" aria-labelledby="belief-title">
      <div class="section-index reveal">02 / A COMPANION, NOT A CHAT WINDOW</div>
      <div class="belief-copy reveal">
        <p class="section-kicker">不是把 AI 放进聊天框，而是让伙伴真正来到你的世界</p>
        <h2 id="belief-title">她会听你说话，<br />也会走到你身边。</h2>
      </div>
      <div class="belief-note reveal">
        <p>MineClaw 让伙伴和你聊天，听见你的想法，也用自己的语气回应你。更重要的是，她不是屏幕外的抽象助手：她拥有 Minecraft 里的身体、位置和背包，能来到你的身边，和你进入同一个正在发生的故事。</p>
        <span class="hand-note">Talk. Play. Explore. Grow together →</span>
      </div>
      <div class="belief-sequence reveal" aria-label="从独自一人到伙伴来到身边的故事转场">
        <figure class="belief-frame">
          <img src="./media/ai-keyframes/01-solitude-start.png?v=20260827-2205" alt="玩家独自在山林中眺望远方的概念故事画面" loading="lazy" decoding="async" />
          <figcaption><span>BEFORE</span><strong>世界很大，但故事还只有一个人。</strong></figcaption>
        </figure>
        <span class="belief-arrow" aria-hidden="true">→</span>
        <figure class="belief-frame">
          <img src="./media/ai-keyframes/01-solitude-end.png?v=20260827-2205" alt="伙伴从林间走来与玩家相遇的概念故事画面" loading="lazy" decoding="async" />
          <figcaption><span>TOGETHER</span><strong>直到另一个人真正走进同一个世界。</strong></figcaption>
        </figure>
        <p class="concept-label"><i></i> AI STORY FRAME · CONCEPT RENDER</p>
      </div>
    </section>

    <section class="proof-ribbon" aria-label="玩家与 MineClaw 伙伴的四种共同体验">
      <div class="page-shell proof-ribbon-grid">
        <article class="metric reveal"><strong>聊天</strong><span>听你说，也回应你<br />不是一次性的命令输入</span></article>
        <article class="metric reveal"><strong>陪玩</strong><span>不只旁观<br />进入你正在玩的世界</span></article>
        <article class="metric reveal"><strong>冒险</strong><span>走到你身边<br />和你一起向远处出发</span></article>
        <article class="metric reveal"><strong>共创</strong><span>真正动手<br />把想法变成世界结果</span></article>
      </div>
    </section>

    <section class="companion-motion" id="motion" aria-labelledby="motion-title">
      <div class="page-shell">
        <div class="motion-heading reveal">
          <div>
            <div class="section-index">02 / COMPANION IN MOTION</div>
            <p class="section-kicker light">她不是站在原地等一句命令，而是会用行动进入你们的故事</p>
            <h2 id="motion-title">打个招呼，带上工具，<br />然后一起出发。</h2>
          </div>
          <p>从第一次见面，到下矿探索，再到把工作台搬进新家——同一个伙伴会以不同姿态回应正在发生的事情。下面是基于当前角色外观制作的动作渲染，用来呈现她的性格与行动感。</p>
        </div>

        <div class="action-scenes" aria-label="MineClaw 伙伴的三种动作渲染">
          <article class="action-scene scene-wave reveal">
            <span class="pose-meta">CHARACTER POSE · ART RENDER</span>
            <div class="pose-stage">
              <span class="pose-orbit" aria-hidden="true"></span>
              <figure class="pose-figure"><img src="./media/characters/companion-wave.png" alt="粉色服装的 MineClaw 伙伴抬起手向玩家挥手" loading="lazy" decoding="async" /></figure>
            </div>
            <div class="pose-copy"><span>01 / HELLO</span><h3>“你来啦。”</h3><p>先向你挥挥手，再走进同一个世界。</p></div>
          </article>

          <article class="action-scene scene-explore reveal">
            <span class="pose-meta">CHARACTER POSE · ART RENDER</span>
            <div class="pose-stage">
              <span class="pose-orbit" aria-hidden="true"></span>
              <figure class="pose-figure"><img src="./media/characters/companion-explore.png" alt="MineClaw 伙伴拿着铁镐迈步出发探索" loading="lazy" decoding="async" /></figure>
            </div>
            <div class="pose-copy"><span>02 / EXPLORE</span><h3>“矿洞那边，走吧。”</h3><p>带上铁镐，和你一起向未知的地方出发。</p></div>
          </article>

          <article class="action-scene scene-build reveal">
            <span class="pose-meta">CHARACTER POSE · ART RENDER</span>
            <div class="pose-stage">
              <span class="pose-orbit" aria-hidden="true"></span>
              <figure class="pose-figure"><img src="./media/characters/companion-build.png" alt="MineClaw 伙伴双手抱着工作台准备一起建设" loading="lazy" decoding="async" /></figure>
            </div>
            <div class="pose-copy"><span>03 / BUILD</span><h3>“工作台放这里吗？”</h3><p>不只陪你看，也真正参与共同生活的现场。</p></div>
          </article>
        </div>

        <p class="motion-disclaimer reveal"><span></span>角色动作渲染用于页面叙事；真实运行能力与结果请继续查看下方实机证据。</p>
      </div>
    </section>

    <section class="companion-details page-shell" id="companion" aria-labelledby="companion-title">
      <div class="section-index reveal">03 / WHO SHE IS</div>
      <div class="details-heading reveal">
        <div>
          <p class="section-kicker">她不是一个等你下命令的角色，而是有自己性格的游戏好友</p>
          <h2 id="companion-title">先认识她这个人，<br />再和她一起出发。</h2>
        </div>
        <p class="details-lead">MineClaw 里的伙伴随和、坦率，有一点幽默，也有自己的偏好。她喜欢 Minecraft，但不会把你们之间的每句话都变成任务：可以聊今天发生的事，可以约着上线，也可以对下一次冒险有不同意见。</p>
      </div>

      <div class="details-layout">
        <div class="details-copy reveal">
          <div class="detail-list" aria-label="MineClaw 伙伴的人格与关系细节">
            <article>
              <span>01</span>
              <div><strong>她有自己的性格</strong><p>不是万能客服的标准答案。她会自然表达想法、好奇和判断，也保留自己的语气与边界。</p></div>
            </article>
            <article>
              <span>02</span>
              <div><strong>你们是平等的游戏好友</strong><p>不是主人和仆从，也不是接单工具。你们能开玩笑、讨论计划、主动邀约，也能表达不同意见。</p></div>
            </article>
            <article>
              <span>03</span>
              <div><strong>她不会用想象冒充正在发生</strong><p>没进入游戏、看不见目标或行动失败时，她会如实说明；真正的陪伴建立在共同看见的事实里。</p></div>
            </article>
          </div>
        </div>

        <figure class="details-capture reveal">
          <div class="screen-frame live-capture">
            <div class="screen-chrome"><span></span><span></span><span></span><b>MINECLAW · COMPANION RELATIONSHIP</b><small>REAL PRODUCT CAPTURE</small></div>
            <img src="./media/images/live-relationship.jpg?v=20260828-141500" alt="MineClaw 当前伙伴配置页面，展示伙伴身份、性格和 AI Agent 配置" loading="lazy" />
          </div>
          <figcaption><span>REAL 01</span><strong>每个伙伴都有自己的身份</strong><p>最新伙伴配置页完整展示名字、皮肤、性格描述与 AI Agent 选择；她如何说话、如何判断，都从清晰可见的设定开始。</p></figcaption>
        </figure>
      </div>
    </section>

    <section class="feature-stories page-shell" id="life" aria-labelledby="feature-title">
      <div class="section-index reveal">04 / A DAY TOGETHER</div>
      <div class="section-heading reveal">
        <p class="section-kicker">陪伴不是一个功能，是一段持续发生的共同经历</p>
        <h2 id="feature-title">从第一句话，<br />到一起走进夜色。</h2>
      </div>

      <div class="story-grid">
        <article class="story story-world reveal">
          <div class="story-number">A</div>
          <figure class="story-frame">
            <img src="./media/ai-keyframes/02-meeting-end.png?v=20260827-2205" alt="MineClaw 伙伴在 Minecraft 山林中第一次来到玩家身边的概念故事画面" loading="lazy" decoding="async" />
            <figcaption><i></i> AI STORY FRAME · CONCEPT RENDER</figcaption>
          </figure>
          <div class="story-copy">
            <p class="story-label">MEET IN THE WORLD</p>
            <h3>上线以后，<br />她会来到你的身边。</h3>
            <p>先聊聊今天想做什么，再一起进入同一个 Minecraft 世界。MineClaw 里的伙伴不是留在聊天框里的声音：她会自主走到玩家附近，以真实角色和你站在同一片方块上。</p>
          </div>
        </article>

        <article class="story story-skill reveal">
          <div class="story-number">B</div>
          <figure class="story-frame">
            <img src="./media/ai-keyframes/06-building-together.png?v=20260827-2205" alt="MineClaw 伙伴与玩家在木屋前共同布置工作台和营地设施的概念故事画面" loading="lazy" decoding="async" />
            <figcaption><i></i> AI STORY FRAME · CONCEPT RENDER</figcaption>
          </figure>
          <div class="story-copy">
            <p class="story-label">BUILD TOGETHER</p>
            <h3>你说起想建的家。<br />她和你一起准备现场。</h3>
            <p>你决定基地要变成什么样，她能制作工作台、熔炉和箱子，也能把床与火把放到指定位置。这里的“一起建造”，不是一句气氛文案，而是她真的参与准备现场。</p>
          </div>
        </article>

        <article class="story story-memory reveal">
          <div class="story-number">C</div>
          <figure class="story-frame">
            <img src="./media/ai-keyframes/07-supplies-together.png?v=20260827-2205" alt="MineClaw 伙伴与玩家在木屋前共同整理箱子、铁镐与火把的概念故事画面" loading="lazy" decoding="async" />
            <figcaption><i></i> AI STORY FRAME · CONCEPT RENDER</figcaption>
          </figure>
          <div class="story-copy">
            <p class="story-label">GET READY TOGETHER</p>
            <h3>出发之前，<br />我们一起把物资准备好。</h3>
            <p>MineClaw 里的伙伴能从指定箱子取出物品交给你，把背包里的材料存进去，也能在两个容器之间按数量搬运。前后库存和物品总量都要对得上，冒险前的准备由你们共同完成。</p>
          </div>
        </article>

        <article class="story story-observe reveal">
          <div class="story-number">D</div>
          <figure class="story-frame">
            <img src="./media/ai-keyframes/08-cave-adventure.png?v=20260827-2205" alt="MineClaw 伙伴与玩家在矿洞里一个采矿、一个提灯协作探索的概念故事画面" loading="lazy" decoding="async" />
            <figcaption><i></i> AI STORY FRAME · CONCEPT RENDER</figcaption>
          </figure>
          <div class="story-copy">
            <p class="story-label">ADVENTURE TOGETHER</p>
            <h3>你走进森林和矿洞。<br />她会从远处跟上。</h3>
            <p>MineClaw 里的伙伴能自主导航到你身边，并在你继续移动时保持跟随。路上可以继续聊天，也能看到彼此正在做什么——冒险终于不只是一个人走过的路。</p>
          </div>
        </article>
      </div>
    </section>

    <section class="screens-section" id="screens" aria-labelledby="screens-title">
      <div class="page-shell">
        <div class="screens-heading reveal">
          <div>
            <p class="section-kicker light">真实截图不是装饰，而是一条从身体、感知到思考的证据链</p>
            <h2 id="screens-title">此刻她看见什么、带着什么，<br />我们都能一起看见。</h2>
          </div>
          <p>下面的画面来自当前 public/main 版本的真实界面。我们保留完整浏览器视野，不再裁掉侧栏、导航或关键状态；你能看见伙伴的身体，以及感知、背包、聊天、任务、角色卡与思考轨迹。</p>
        </div>
        <p class="capture-instance-note reveal"><strong>产品名称：MineClaw</strong><span>画面中的角色昵称仅是当前演示伙伴实例，不代表产品品牌。</span></p>

        <figure class="screen-feature live-evidence reveal">
          <div class="screen-frame live-capture perception-capture">
            <div class="screen-chrome"><span></span><span></span><span></span><b>MINECLAW · COMPANION PERCEPTION</b><small>CURRENT PUBLIC/MAIN · FULL VIEW</small></div>
            <img src="./media/images/live-perception.jpg?v=20260828-141500" alt="MineClaw 当前游玩总览完整页面，展示伙伴列表、雷达感知区和伙伴状态面板" loading="lazy" />
          </div>
          <figcaption><span>02</span><strong>她此刻能看见什么，一目了然</strong><p>最新游玩总览把伙伴列表、三维感知区与实时状态放在同一屏。截图使用安全的离线演示实例，因此如实显示感知待机状态；伙伴上线后，这里会渲染她正在感知的周围世界。</p></figcaption>
        </figure>

        <div class="screen-pair">
          <figure class="screen-world reveal">
            <div class="world-shot">
              <img src="./media/images/mineclaw-companion-in-world.png?v=20260828-141500" alt="MineClaw 当前 App 真实世界待机页面，展示伙伴列表、感知空间和伙伴面板" loading="lazy" />
              <div class="world-shot-tag"><i></i> MINECLAW · COMPANION IN WORLD</div>
            </div>
            <figcaption><span>03</span><strong>她真正来到我的世界</strong><p>拥有 Minecraft 身体、位置和背包，不是屏幕外的一个声音；你可以在同一片方块上看到她、找到她，和她并肩出发。</p></figcaption>
          </figure>
          <figure class="screen-inventory reveal">
            <div class="screen-frame live-capture inventory-capture">
              <div class="screen-chrome"><span></span><span></span><span></span><b>MINECLAW · COMPANION INVENTORY</b><small>CURRENT PUBLIC/MAIN · FULL VIEW</small></div>
              <img src="./media/images/live-inventory.jpg?v=20260828-141500" alt="MineClaw 当前背包页面完整视图，保留真实世界待机区和右侧背包面板" loading="lazy" />
            </div>
            <figcaption><span>04</span><strong>行动会在背包里留下实物</strong><p>背包页和伙伴当前状态同屏呈现。演示伙伴未上线时，界面明确显示“暂无背包数据”；连接世界后，采集、制作和整理留下的真实物品会出现在这里。</p></figcaption>
          </figure>
        </div>

        <div class="screen-pair conversation-pair">
          <figure class="screen-chat reveal">
            <div class="screen-frame webui-capture">
              <div class="screen-chrome"><span></span><span></span><span></span><b>CONVERSATION</b><small>CURRENT PUBLIC/MAIN · FULL VIEW</small></div>
              <img src="./media/images/mineclaw-companion-chat.png?v=20260828-141500" alt="MineClaw 当前聊天页面完整视图，包含伙伴、感知和聊天记录区域" loading="lazy" />
            </div>
            <figcaption><span>05</span><strong>一起做事，也一直保持对话</strong><p>聊天页始终与伙伴当前状态相连。离线实例会禁用输入并保留清晰提示；连接后，她能回应你的话，也能在共同做事时持续汇报进展。</p></figcaption>
          </figure>
          <figure class="screen-running reveal">
            <div class="screen-frame webui-capture">
              <div class="screen-chrome"><span></span><span></span><span></span><b>TASK WORKBENCH</b><small>CURRENT PUBLIC/MAIN · FULL VIEW</small></div>
              <img src="./media/images/task-workbench-running.jpg?v=20260828-141500" alt="MineClaw 当前任务栏完整视图，如实展示任务汇总和空状态" loading="lazy" />
            </div>
            <figcaption><span>06</span><strong>一起做的事有过程</strong><p>任务栏同时展示进行中、暂停与归档数量。当前演示实例未启动运行时，页面如实给出可重试的空状态；运行后，每一步进展与遇到的问题都会留在这里。</p></figcaption>
          </figure>
        </div>

        <figure class="screen-feature completed-screen reveal">
          <div class="screen-frame webui-capture">
            <div class="screen-chrome"><span></span><span></span><span></span><b>MINECLAW · COMPANION ROLE CARD</b><small>CURRENT PUBLIC/MAIN · FULL VIEW</small></div>
            <img src="./media/images/live-role-card.jpg?v=20260828-141500" alt="MineClaw 当前角色卡完整页面，展示身份、背景、人格和表达方式" loading="lazy" />
          </div>
          <figcaption><span>07</span><strong>她不只是一套能力，也有完整角色</strong><p>角色卡把身份、背景、自我认知、人格、价值观和边界放在同一处。你可以看见这个伙伴如何认识自己，也能决定你们要以怎样的关系相处。</p></figcaption>
        </figure>

        <figure class="screen-feature trace-screen reveal">
          <div class="screen-frame live-capture trace-capture">
            <div class="screen-chrome"><span></span><span></span><span></span><b>MINECLAW · COMPANION THOUGHT TRACE</b><small>CURRENT PUBLIC/MAIN · FULL VIEW</small></div>
            <img src="./media/images/live-trace.jpg?v=20260828-141500" alt="MineClaw 当前演示伙伴的轨迹工作台，展示回合、模型调用和事件账本" loading="lazy" />
          </div>
          <figcaption><span>08</span><strong>连她怎么理解、怎么选择，也能回看</strong><p>轨迹工作台完整呈现筛选、会话、事件账本与调用检查器。未运行时会明确显示服务状态；运行后，每次理解、调用和恢复都能沿事件链继续下钻。</p></figcaption>
        </figure>
      </div>
    </section>

    <section class="loop-section" id="loop" aria-labelledby="loop-title">
      <div class="page-shell">
        <div class="loop-heading reveal">
          <div>
            <p class="section-kicker light">为什么这个伙伴不只会聊天</p>
            <h2 id="loop-title">她能听懂你，<br />也能在世界里把事情做出来。</h2>
          </div>
          <p>采集并交付材料、制作并放置工作站、整理容器、来到你身边并持续跟随——这些动作让陪伴从语言变成共同生活。她接收目标、拆成行动并读取真实结果；走不通、缺材料或位置不对时会重新规划。</p>
        </div>

        <div class="loop-map reveal" aria-label="MineClaw 伙伴从理解到记忆的行动循环">
          <div class="loop-orbit orbit-one" aria-hidden="true"></div>
          <div class="loop-orbit orbit-two" aria-hidden="true"></div>
          <div class="loop-center">
            <span>YOUR GOAL</span>
            <strong>世界真的<br />发生变化</strong>
            <small>自然语言 · 自主执行 · 实物验真</small>
          </div>
          <article class="loop-node node-understand"><span>01</span><strong>听懂</strong><small>Understand</small></article>
          <article class="loop-node node-plan"><span>02</span><strong>想办法</strong><small>Plan</small></article>
          <article class="loop-node node-act"><span>03</span><strong>动手做</strong><small>Act</small></article>
          <article class="loop-node node-observe"><span>04</span><strong>看结果</strong><small>Observe</small></article>
          <article class="loop-node node-critic"><span>05</span><strong>不敷衍</strong><small>Verify</small></article>
          <article class="loop-node node-recover"><span>06</span><strong>再试一次</strong><small>Recover</small></article>
          <div class="loop-success"><span></span> WORLD STATE MATCHES YOUR GOAL</div>
        </div>

        <div class="tech-proof reveal" aria-label="项目技术实证">
          <span><strong>20/20</strong> 真服短程能力通过</span>
          <span><strong>10</strong> 个节点连续闭环</span>
          <span><strong>100%</strong> 关键调用可下钻</span>
          <span><strong>3</strong> 种沟通节奏可选</span>
          <a class="tech-proof-link" href="./architecture.html">查看完整框架实现 <span aria-hidden="true">→</span></a>
        </div>
      </div>
    </section>

    <section class="finale" aria-labelledby="finale-title">
      <div class="finale-bg" style="background-image: url('./media/ai-keyframes/05-finale-end.png?v=20260827-2205')" aria-hidden="true"></div>
      <div class="finale-veil" aria-hidden="true"></div>
      <p class="finale-concept"><i></i> AI STORY FRAME · CONCEPT RENDER</p>
      <div class="page-shell finale-content reveal">
        <p class="eyebrow"><span class="eyebrow-dot"></span> A WORLD TO SHARE · A STORY THAT CONTINUES</p>
        <h2 id="finale-title">我们创造的不只是一个 NPC。<br /><em>而是一段会在虚拟世界里继续发生的关系。</em></h2>
        <p>她陪你聊天、陪你玩、和你一起冒险，也在你需要时真正动手。方块组成世界；一起经历的事情，才让它成为你们共同生活过的地方。</p>
        <div class="finale-actions">
          <a class="button button-light" href="#top">回到开头 <span aria-hidden="true">↑</span></a>
          <a class="text-action" href="https://github.com/Be1Human/MineClaw" target="_blank" rel="noreferrer">查看 MineClaw GitHub 仓库 <span aria-hidden="true">↗</span></a>
        </div>
      </div>
    </section>
  </main>

  <footer class="site-footer page-shell">
    <a class="brand dark-brand" href="#top" aria-label="返回 MineClaw 首页"><img class="brand-mark" src="./brand/mineclaw-mark.svg" alt="" aria-hidden="true" /><span class="brand-copy"><strong>MineClaw</strong><small>VIRTUAL WORLD COMPANION</small></span></a>
    <p>让虚拟世界里，真正住进一个懂你的伙伴。</p>
    <a class="footer-link" href="https://github.com/Be1Human/MineClaw" target="_blank" rel="noreferrer">GitHub Repository ↗</a>
  </footer>
`;

const mediaConfig = window.MINECLAW_SHOWCASE_MEDIA || {};

function hydrateMediaSlot(slot) {
  const key = slot.dataset.mediaKey;
  const config = mediaConfig[key];
  const placeholder = slot.querySelector('.media-placeholder');

  if (!config?.src) {
    if (placeholder && config?.poster) {
      placeholder.classList.add('has-poster');
      placeholder.style.backgroundImage = `linear-gradient(180deg, rgba(10, 14, 9, 0.2), rgba(10, 14, 9, 0.9)), url("${config.poster}")`;
    }
    return;
  }

  const video = document.createElement('video');
  video.className = 'media-video';
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = config.src;
  if (config.poster) video.poster = config.poster;
  video.setAttribute('aria-label', config.title || slot.querySelector('h3')?.textContent || 'MineClaw 演示视频');

  video.addEventListener('error', () => {
    video.remove();
    placeholder.hidden = false;
    slot.classList.add('media-error');
    const state = placeholder.querySelector('.media-state');
    if (state) state.textContent = '视频暂不可用';
  }, { once: true });

  placeholder.hidden = true;
  placeholder.after(video);
  slot.classList.add('has-video');
}

document.querySelectorAll('[data-media-key]').forEach(hydrateMediaSlot);

const header = document.querySelector('[data-header]');
const navToggle = document.querySelector('[data-nav-toggle]');
const mobileNav = document.querySelector('[data-mobile-nav]');

function closeMobileNav() {
  navToggle.setAttribute('aria-expanded', 'false');
  header.classList.remove('nav-open');
}

navToggle.addEventListener('click', () => {
  const open = navToggle.getAttribute('aria-expanded') === 'true';
  navToggle.setAttribute('aria-expanded', String(!open));
  header.classList.toggle('nav-open', !open);
});

mobileNav.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMobileNav));

window.addEventListener('scroll', () => {
  header.classList.toggle('scrolled', window.scrollY > 36);
}, { passive: true });

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const reveals = document.querySelectorAll('.reveal');

if (reducedMotion || !('IntersectionObserver' in window)) {
  reveals.forEach((element) => element.classList.add('visible'));
} else {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  reveals.forEach((element) => revealObserver.observe(element));
}

const navLinks = [...document.querySelectorAll('.desktop-nav a[href^="#"]')];
const sections = navLinks
  .map((link) => document.querySelector(link.getAttribute('href')))
  .filter(Boolean);

if ('IntersectionObserver' in window) {
  const sectionObserver = new IntersectionObserver((entries) => {
    const visible = entries.find((entry) => entry.isIntersecting);
    if (!visible) return;
    navLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`));
  }, { rootMargin: '-35% 0px -55% 0px', threshold: 0 });
  sections.forEach((section) => sectionObserver.observe(section));
}
