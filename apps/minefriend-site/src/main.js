import './style.css';

document.documentElement.classList.add('js');

const app = document.querySelector('#app');

app.innerHTML = `
  <header class="site-header" data-header>
    <a class="brand" href="#top" aria-label="MineClaw 首页">
      <span class="brand-cube" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="brand-copy"><strong>MineClaw</strong><small>A COMPANION WHO LIVES, PLAYS & GROWS WITH YOU</small></span>
    </a>
    <nav class="desktop-nav" aria-label="主导航">
      <a href="#why">她是谁</a>
      <a href="#life">我们的一天</a>
      <a href="#screens">真实世界</a>
      <a href="#demo">故事影像</a>
    </nav>
    <a class="header-cta" href="https://git.code.tencent.com/CloudBoy/MineClaw" target="_blank" rel="noreferrer" aria-label="在新窗口打开 MineClaw Git 仓库">Git 仓库 <span aria-hidden="true">↗</span></a>
    <button class="nav-toggle" type="button" aria-label="展开导航" aria-expanded="false" data-nav-toggle>
      <span></span><span></span>
    </button>
    <nav class="mobile-nav" aria-label="移动端导航" data-mobile-nav>
      <a href="#why">她是谁</a>
      <a href="#life">我们的一天</a>
      <a href="#screens">真实世界</a>
      <a href="#demo">故事影像</a>
      <a href="https://git.code.tencent.com/CloudBoy/MineClaw" target="_blank" rel="noreferrer">Git 仓库 ↗</a>
    </nav>
  </header>

  <main id="top">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-media" style="background-image: url('./media/images/minefriend-hero-v2.png')" aria-hidden="true"></div>
      <div class="hero-veil" aria-hidden="true"></div>
      <div class="hero-grid" aria-hidden="true"></div>
      <div class="page-shell hero-content">
        <div class="hero-copy">
          <p class="eyebrow"><span class="eyebrow-dot"></span> A COMPANION WHO LIVES IN YOUR WORLD</p>
          <h1 id="hero-title">让虚拟世界里，<br /><em>真正住进一个懂你的伙伴。</em></h1>
          <p class="hero-lead">
            她会陪你聊天，和你玩游戏，走进 Minecraft 站到你身边。你们一起建造、探洞，经历危险和惊喜；当你需要时，她还能真正动手，和你一起把事情完成。
          </p>
          <div class="hero-actions">
            <a class="button button-primary" href="#why">认识 MineClaw <span aria-hidden="true">↓</span></a>
            <a class="button button-ghost" href="#life">看我们一起冒险 <span aria-hidden="true">↗</span></a>
          </div>
        </div>
        <aside class="hero-proof companion-card" aria-label="MineClaw 虚拟世界伙伴状态">
          <p class="proof-kicker">MINECLAW · COMPANION IN YOUR WORLD</p>
          <div class="companion-head">
            <span class="companion-avatar" aria-hidden="true">L</span>
            <div><strong>MineClaw</strong><span><i></i> 伙伴正在和你一起冒险</span></div>
          </div>
          <div class="proof-divider"></div>
          <p class="companion-whisper">“今天想去哪？我会走到你身边，和你一起出发。”</p>
          <div class="companion-tags"><span>聊天</span><span>陪玩</span><span>冒险</span><span>一起完成</span></div>
        </aside>
      </div>
      <div class="hero-scroll" aria-hidden="true"><span>SCROLL TO EXPLORE</span><i></i></div>
    </section>

    <section class="belief page-shell" id="why" aria-labelledby="belief-title">
      <div class="section-index reveal">01 / A COMPANION, NOT A CHAT WINDOW</div>
      <div class="belief-copy reveal">
        <p class="section-kicker">不是把 AI 放进聊天框，而是让伙伴真正来到你的世界</p>
        <h2 id="belief-title">她会听你说话，<br />也会走到你身边。</h2>
      </div>
      <div class="belief-note reveal">
        <p>MineClaw 让伙伴和你聊天，听见你的想法，也用自己的语气回应你。更重要的是，她不是屏幕外的抽象助手：她拥有 Minecraft 里的身体、位置和背包，能来到你的身边，和你进入同一个正在发生的故事。</p>
        <span class="hand-note">Talk. Play. Explore. Grow together →</span>
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

    <section class="companion-details page-shell" id="companion" aria-labelledby="companion-title">
      <div class="section-index reveal">02 / WHO SHE IS</div>
      <div class="details-layout">
        <div class="details-copy reveal">
          <p class="section-kicker">她不是一个等你下命令的角色，而是有自己性格的游戏好友</p>
          <h2 id="companion-title">先认识她这个人，<br />再和她一起出发。</h2>
          <p class="details-lead">MineClaw 里的伙伴随和、坦率，有一点幽默，也有自己的偏好。她喜欢 Minecraft，但不会把你们之间的每句话都变成任务：可以聊今天发生的事，可以约着上线，也可以对下一次冒险有不同意见。</p>

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
            <img src="./media/images/live-relationship.jpg" alt="MineClaw 当前演示伙伴配置中的熟悉游戏好友关系、共同经历和相处风格" loading="lazy" />
          </div>
          <figcaption><span>REAL 01</span><strong>关系不是一句宣传语</strong><p>当前角色卡明确记录“熟悉的游戏好友”、共同玩 Minecraft 的经历，以及平等、自然、可以主动邀约和表达不同意见的相处方式。</p></figcaption>
        </figure>
      </div>
    </section>

    <section class="feature-stories page-shell" id="life" aria-labelledby="feature-title">
      <div class="section-index reveal">03 / A DAY TOGETHER</div>
      <div class="section-heading reveal">
        <p class="section-kicker">陪伴不是一个功能，是一段持续发生的共同经历</p>
        <h2 id="feature-title">从第一句话，<br />到一起走进夜色。</h2>
      </div>

      <div class="story-grid">
        <article class="story story-world reveal">
          <div class="story-number">A</div>
          <div class="story-visual world-visual" aria-hidden="true">
            <div class="voxel voxel-a"></div><div class="voxel voxel-b"></div><div class="voxel voxel-c"></div>
            <span class="scan-line"></span>
            <div class="world-readout"><i></i> MINECLAW · COMPANION BESIDE YOU</div>
          </div>
          <div class="story-copy">
            <p class="story-label">MEET IN THE WORLD</p>
            <h3>上线以后，<br />她会来到你的身边。</h3>
            <p>先聊聊今天想做什么，再一起进入同一个 Minecraft 世界。MineClaw 里的伙伴不是留在聊天框里的声音：她会自主走到玩家附近，以真实角色和你站在同一片方块上。</p>
          </div>
        </article>

        <article class="story story-skill reveal">
          <div class="story-number">B</div>
          <div class="story-copy">
            <p class="story-label">BUILD TOGETHER</p>
            <h3>你说起想建的家。<br />她和你一起准备现场。</h3>
            <p>你决定基地要变成什么样，她能制作工作台、熔炉和箱子，也能把床与火把放到指定位置。这里的“一起建造”，不是一句气氛文案，而是她真的参与准备现场。</p>
          </div>
          <div class="skill-stack" aria-label="营地工作站准备结果">
            <span><b>01</b>4 块木板 → 工作台</span>
            <span><b>02</b>8 块圆石 → 熔炉</span>
            <span><b>03</b>8 块木板 → 右侧箱子</span>
            <span class="skill-fast"><b>04</b>火把 → 指定石块顶面 <i>PLACED</i></span>
          </div>
        </article>

        <article class="story story-memory reveal">
          <div class="story-number">C</div>
          <div class="memory-quote">
            <span class="quote-mark">“</span>
            <p>“把左边箱子里的 8 根原木，<br />搬到右边箱子。”</p>
            <small>A 16 → 8 · B 0 → 8 · BOT 归零 · 总量守恒</small>
          </div>
          <div class="story-copy">
            <p class="story-label">GET READY TOGETHER</p>
            <h3>出发之前，<br />我们一起把物资准备好。</h3>
            <p>MineClaw 里的伙伴能从指定箱子取出物品交给你，把背包里的材料存进去，也能在两个容器之间按数量搬运。前后库存和物品总量都要对得上，冒险前的准备由你们共同完成。</p>
          </div>
        </article>

        <article class="story story-observe reveal">
          <div class="story-number">D</div>
          <div class="trace-card" aria-label="模型调用轨迹示意">
            <div class="trace-head"><span><i></i> FOLLOW · ACTIVE</span><b>LIVE</b></div>
            <div class="trace-row active"><span>目标</span><strong>走到我身边，跟着我</strong><small>NOW</small></div>
            <div class="trace-row"><span>行动</span><strong>自主移动到玩家 2 格内</strong><small>8.4s</small></div>
            <div class="trace-row"><span>持续</span><strong>玩家移动后继续跟随</strong><small>ACTIVE</small></div>
          </div>
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
          <p>下面八张画面全部来自真实运行中的 MineClaw。你能看见伙伴在 Minecraft 里的身体、实时坐标与感知、背包实物、聊天、行动过程、完成回执，以及她每一步思考留下的轨迹。</p>
        </div>
        <p class="capture-instance-note reveal"><strong>产品名称：MineClaw</strong><span>画面中的角色昵称仅是当前演示伙伴实例，不代表产品品牌。</span></p>

        <figure class="screen-feature live-evidence reveal">
          <div class="screen-frame live-capture perception-capture">
            <div class="screen-chrome"><span></span><span></span><span></span><b>MINECLAW · LIVE COMPANION PERCEPTION</b><small>2026.08.23 · LIVE WORLD STATE</small></div>
            <img src="./media/images/live-perception.jpg" alt="MineClaw 当前演示伙伴在本地训练服中的实时三维感知、生命饥饿、坐标、方块与实体状态" loading="lazy" />
          </div>
          <figcaption><span>02</span><strong>她此刻正在世界里看见什么</strong><p>实拍时 MineClaw 的演示伙伴在线：生命与饥饿均为 20，坐标、维度、附近 810 个方块、实体和威胁状态都从游戏实时读取；中央 3D 场景就是她正在感知的周围世界。</p></figcaption>
        </figure>

        <div class="screen-pair">
          <figure class="screen-world reveal">
            <div class="world-shot">
              <img src="./media/images/mineclaw-companion-in-world.png" alt="MineClaw 的伙伴真实进入 Minecraft 世界并站在玩家身边" loading="lazy" />
              <div class="world-shot-tag"><i></i> MINECLAW · COMPANION IN WORLD</div>
            </div>
            <figcaption><span>03</span><strong>她真正来到我的世界</strong><p>拥有 Minecraft 身体、位置和背包，不是屏幕外的一个声音；你可以在同一片方块上看到她、找到她，和她并肩出发。</p></figcaption>
          </figure>
          <figure class="screen-inventory reveal">
            <div class="screen-frame live-capture inventory-capture">
              <div class="screen-chrome"><span></span><span></span><span></span><b>MINECLAW · LIVE COMPANION INVENTORY</b><small>LIVE WORLD STATE</small></div>
              <img src="./media/images/live-inventory.jpg" alt="MineClaw 当前演示伙伴在本地训练服的实时背包中可见小麦和种子等实物" loading="lazy" />
            </div>
            <figcaption><span>04</span><strong>行动会在背包里留下实物</strong><p>采集时刻的背包里可见 31 个小麦与两组共 102 个种子。这里证明的是实时物品状态可见，不把当时仍失败的完整收割任务包装成成功。</p></figcaption>
          </figure>
        </div>

        <div class="screen-pair conversation-pair">
          <figure class="screen-chat reveal">
            <div class="screen-frame portrait-frame">
              <div class="screen-chrome"><span></span><span></span><span></span><b>CONVERSATION</b><small>REAL PRODUCT CAPTURE</small></div>
              <img src="./media/images/mineclaw-companion-chat.png" alt="MineClaw 当前演示伙伴在控制台中汇报寻找木头的真实聊天画面" loading="lazy" />
            </div>
            <figcaption><span>05</span><strong>做事时，我们也一直在说话</strong><p>她能回应你的话，也会在共同做事时告诉你正在找什么、做到哪一步；行动不会让这个伙伴突然变成无声脚本。</p></figcaption>
          </figure>
          <figure class="screen-running reveal">
            <div class="screen-frame workbench-crop">
              <div class="screen-chrome"><span></span><span></span><span></span><b>LIVE WORKBENCH</b><small>REAL PRODUCT CAPTURE</small></div>
              <img src="./media/images/task-workbench-running.jpg" alt="MineClaw 控制台展示伙伴正在推进收集橡木任务和实时子步骤" loading="lazy" />
            </div>
            <figcaption><span>06</span><strong>一起做的事有过程</strong><p>说好一个目标后，可以看到 MineClaw 里的伙伴正在推进哪一步、遇到了什么，而不是等一个无法验证的口头答案。</p></figcaption>
          </figure>
        </div>

        <figure class="screen-feature completed-screen reveal">
          <div class="screen-frame">
            <div class="screen-chrome"><span></span><span></span><span></span><b>MINECLAW · COMPLETION RECEIPT</b><small>REAL PRODUCT CAPTURE</small></div>
            <img src="./media/images/task-workbench-completed.jpg" alt="任务完成后 MineClaw 工作台清空当前任务并增加归档计数" loading="lazy" />
          </div>
          <figcaption><span>07</span><strong>共同完成的事有结果</strong><p>背包数量、方块位置、容器内容或玩家距离没有达标，她就不能把一句“完成了”当作结果。达到目标后，任务才进入归档，成为你们真正完成过的共同经历。</p></figcaption>
        </figure>

        <figure class="screen-feature trace-screen reveal">
          <div class="screen-frame live-capture trace-capture">
            <div class="screen-chrome"><span></span><span></span><span></span><b>MINECLAW · COMPANION THOUGHT TRACE</b><small>REAL PRODUCT CAPTURE</small></div>
            <img src="./media/images/live-trace.jpg" alt="MineClaw 当前演示伙伴的大脑轨迹工作台展示回合、模型调用和事件账本" loading="lazy" />
          </div>
          <figcaption><span>08</span><strong>连她怎么理解、怎么选择，也能回看</strong><p>当前轨迹工作台记录了 152 个回合、980 次模型调用，并能继续下钻事件账本。陪伴不再依赖黑箱，每次理解、调用和恢复都有迹可循。</p></figcaption>
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
        </div>
      </div>
    </section>

    <section class="demo-section page-shell" id="demo" aria-labelledby="demo-title">
      <div class="section-index reveal">06 / VIDEO STORIES</div>
      <div class="demo-heading reveal">
        <div>
          <p class="section-kicker">从相遇、相伴，到共同完成一件真正的事</p>
          <h2 id="demo-title">三个故事，看看伙伴如何<br />真正走进一个世界。</h2>
        </div>
        <p>从第一次站在同一片方块上，到一起度过完整的一天，再到把一句话变成世界里的真实结果——每个故事都从正在发生的游戏现场开始。</p>
      </div>

      <div class="media-grid">
        <article class="media-slot reveal" data-media-key="overview">
          <div class="media-placeholder">
            <span class="media-state"><i></i> 场景预览</span>
            <strong class="media-duration">01:30</strong>
            <div class="media-play" aria-hidden="true">▶</div>
            <p>玩家上线 → MineClaw 的伙伴出现在世界中 → 自主走到玩家身边 → 第一次面对面聊天 → 一起决定今天去哪</p>
          </div>
          <div class="media-copy"><span>FILM 01</span><h3>一个伙伴，真正走进我的世界</h3></div>
        </article>
        <article class="media-slot reveal" data-media-key="recovery">
          <div class="media-placeholder clay">
            <span class="media-state"><i></i> 场景预览</span>
            <strong class="media-duration">00:45</strong>
            <div class="media-play" aria-hidden="true">▶</div>
            <p>晨光里聊天 → 一起准备营地与物资 → 穿过森林 → 走进矿洞 → 夜色中并肩回到家</p>
          </div>
          <div class="media-copy"><span>FILM 02</span><h3>我们一起度过 Minecraft 的一天</h3></div>
        </article>
        <article class="media-slot reveal" data-media-key="memory">
          <div class="media-placeholder amber">
            <span class="media-state"><i></i> 场景预览</span>
            <strong class="media-duration">00:45</strong>
            <div class="media-play" aria-hidden="true">▶</div>
            <p>玩家说出目标 → MineClaw 的伙伴理解并规划 → 采集、制作或整理 → 遇阻调整 → 世界结果与共同完成画面</p>
          </div>
          <div class="media-copy"><span>FILM 03</span><h3>她不只听懂我，还能和我一起把事做成</h3></div>
        </article>
      </div>
    </section>

    <section class="finale" aria-labelledby="finale-title">
      <div class="finale-bg" style="background-image: url('./media/images/minefriend-hero-v2.png')" aria-hidden="true"></div>
      <div class="finale-veil" aria-hidden="true"></div>
      <div class="page-shell finale-content reveal">
        <p class="eyebrow"><span class="eyebrow-dot"></span> A WORLD TO SHARE · A STORY THAT CONTINUES</p>
        <h2 id="finale-title">我们创造的不只是一个 NPC。<br /><em>而是一段会在虚拟世界里继续发生的关系。</em></h2>
        <p>她陪你聊天、陪你玩、和你一起冒险，也在你需要时真正动手。方块组成世界；一起经历的事情，才让它成为你们共同生活过的地方。</p>
        <div class="finale-actions">
          <a class="button button-light" href="#top">回到开头 <span aria-hidden="true">↑</span></a>
          <a class="text-action" href="https://git.code.tencent.com/CloudBoy/MineClaw" target="_blank" rel="noreferrer">查看 MineClaw Git 仓库 <span aria-hidden="true">↗</span></a>
        </div>
      </div>
    </section>
  </main>

  <footer class="site-footer page-shell">
    <a class="brand dark-brand" href="#top"><span class="brand-cube" aria-hidden="true"><i></i><i></i><i></i></span><span class="brand-copy"><strong>MineClaw</strong><small>VIRTUAL WORLD COMPANION</small></span></a>
    <p>让虚拟世界里，真正住进一个懂你的伙伴。</p>
    <a class="footer-link" href="https://git.code.tencent.com/CloudBoy/MineClaw" target="_blank" rel="noreferrer">Git Repository ↗</a>
  </footer>
`;

const mediaConfig = window.MINECLAW_SHOWCASE_MEDIA || {};

function hydrateMediaSlot(slot) {
  const key = slot.dataset.mediaKey;
  const config = mediaConfig[key];
  if (!config?.src) return;

  const placeholder = slot.querySelector('.media-placeholder');
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
  slot.insertBefore(video, slot.querySelector('.media-copy'));
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

const navLinks = [...document.querySelectorAll('.desktop-nav a')];
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
