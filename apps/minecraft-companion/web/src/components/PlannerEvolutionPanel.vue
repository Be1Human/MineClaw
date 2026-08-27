<template>
  <section class="evolution-shell">
    <header class="evolution-header">
      <div>
        <div class="eyebrow">PLANNER EVOLUTION · 经验驱动规划</div>
        <h1>进化中心</h1>
        <p>查看伙伴学到的任务结构、失败模式、证据关系和当前可信 Policy。</p>
      </div>
      <div class="header-actions">
        <span :class="['freshness', summary?.counts?.knowledgeNodes > 0 ? 'ready' : 'empty']">
          {{ evolutionStatusText }}
        </span>
        <button :disabled="!summary?.available || loading" @click="exportAudit">导出当前审计包</button>
        <button class="primary" :disabled="!botId || loading" @click="refresh">刷新</button>
      </div>
    </header>

    <div v-if="!botId" class="empty-state">
      <strong>先选择一个伙伴</strong>
      <span>图谱按伙伴隔离，不会混用不同角色的经验。</span>
    </div>

    <template v-else>
      <div class="kpi-grid">
        <article>
          <span>已抽象经验</span>
          <strong>{{ summary?.counts?.knowledgeNodes ?? 0 }}</strong>
          <small>任务结构、片段、失败模式、候选</small>
        </article>
        <article>
          <span>经验关系</span>
          <strong>{{ summary?.counts?.knowledgeEdges ?? 0 }}</strong>
          <small>依赖、支持、反驳、进化</small>
        </article>
        <article>
          <span>运行证据</span>
          <strong>{{ summary?.counts?.runtimeEvidenceNodes ?? 0 }}</strong>
          <small>Episode、事实与实际计划，不等于经验</small>
        </article>
        <article class="policy-card">
          <span>{{ selectedExperienceLineage ? '当前任务经验' : '可信经验' }}</span>
          <strong>{{ selectedExperienceLineage?.currentPolicyId ? `V${selectedExperienceLineage.versions.find(item => item.policy.id === selectedExperienceLineage.currentPolicyId)?.policy.version ?? '?'}` : selectedExperienceLineage ? maturityLabel(selectedExperienceLineage.maturity) : `${trustedLineageCount} 项` }}</strong>
          <small>{{ selectedExperienceLineage ? selectedExperienceLineage.goalPattern : '按具体任务独立晋升，不使用全局版本号' }}</small>
        </article>
      </div>

      <nav class="view-tabs" aria-label="进化视图">
        <button v-for="item in views" :key="item.id" :class="{ active: view === item.id }" @click="view = item.id">
          {{ item.name }}<small>{{ item.hint }}</small>
        </button>
      </nav>

      <section v-if="dashboard.experienceLineages.length" class="task-context" aria-label="当前具体任务经验">
        <div>
          <span>当前具体任务经验</span>
          <strong>{{ selectedExperienceLineage?.goalPattern || '请选择任务' }}</strong>
          <small v-if="selectedExperienceLineage">
            {{ maturityLabel(selectedExperienceLineage.maturity) }} · {{ selectedExperienceLineage.planRunIds.length }} 次真实运行 · {{ selectedExperienceLineage.versions.length ? `${selectedExperienceLineage.versions.length} 个版本` : 'V0 尚无 Policy' }}
          </small>
        </div>
        <select :value="selectedExperienceLineage?.id || ''" @change="selectExperienceById">
          <option v-for="lineage in dashboard.experienceLineages" :key="lineage.id" :value="lineage.id">
            {{ lineage.goalPattern }} · {{ maturityLabel(lineage.maturity) }}
          </option>
        </select>
        <button
          v-if="selectedExperienceLineage?.candidateId || selectedExperienceLineage?.currentPolicyId"
          :disabled="loading"
          @click="viewSelectedExperienceGraph"
        >查看这条经验图谱</button>
      </section>

      <section
        v-if="selectedExperienceLineage?.candidateId && !selectedExperienceLineage.currentPolicyId"
        :class="['experiment-gate', { ready: dashboard.runtimeGate?.candidateTrialsEnabled }]"
        aria-label="候选经验实验运行门"
      >
        <div>
          <span>候选实验运行门</span>
          <strong>{{ experimentGateTitle }}</strong>
          <small>{{ experimentGateDetail }}</small>
        </div>
        <div class="gate-facts">
          <span>进化 {{ dashboard.runtimeGate?.evolutionMode || 'observe' }}</span>
          <span>实验 {{ dashboard.runtimeGate?.experimentMode || 'off' }}</span>
          <span>角色 {{ dashboard.runtimeGate?.profileAuthorized ? '已授权' : '未在白名单' }}</span>
        </div>
      </section>

      <template v-if="view === 'capability'">
      <div class="toolbar">
        <input v-model="search" type="search" placeholder="搜索任务、经验或失败模式" @keyup.enter="loadOverview" />
        <select v-model="type" @change="loadOverview">
          <option value="">全部经验类型</option>
          <option v-for="item in nodeTypes" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
        <button :disabled="loading" @click="loadOverview">筛选</button>
        <button v-if="focusedRoot" :disabled="loading" @click="resetOverview">返回全图</button>
        <span class="result-count">{{ graph.nodes.length }} 节点 · {{ graph.edges.length }} 关系</span>
      </div>

      <div v-if="error" class="notice error">{{ error }}</div>
      <div v-if="loading" class="empty-state">正在读取规划经验图谱…</div>
      <div v-else-if="!summary?.available || graph.nodes.length === 0" class="empty-state learning-empty">
        <div class="empty-icon">◇</div>
        <strong>{{ !summary?.available ? '还没有可展示的规划经验' : summary?.counts?.knowledgeNodes > 0 ? '当前筛选下没有节点' : '已有运行证据，尚未形成经验' }}</strong>
        <span v-if="!summary?.available">完成首批任务并经过归因、验证后，能力节点和进化关系会出现在这里。</span>
        <span v-else-if="summary?.counts?.knowledgeNodes > 0">清除筛选条件，或等待新的 Episode 形成可信经验。</span>
        <span v-else>完成一次可归因的成功或结构化失败后，系统才会把证据抽象为任务结构、失败模式或 Candidate。</span>
      </div>

      <div v-else class="workspace">
        <section class="graph-panel">
          <div class="panel-title">
            <div>
              <strong>{{ focusedRoot ? '局部经验子图' : '能力与经验总览' }}</strong>
              <span>{{ graph.truncated ? '结果已按安全上限截断' : '点击节点查看证据和适用边界' }}</span>
            </div>
            <div class="legend">
              <span v-for="item in visibleLegend" :key="item.id"><i :style="{ background: item.color }"></i>{{ item.name }}</span>
            </div>
          </div>

          <svg
            class="graph-canvas"
            :viewBox="`0 0 1100 ${canvasHeight}`"
            :style="{ minHeight: `${Math.max(500, canvasHeight * 0.72)}px` }"
            role="img"
            aria-label="规划经验知识图谱"
          >
            <defs>
              <marker id="evolution-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#68705c" />
              </marker>
            </defs>
            <g class="edges">
              <line
                v-for="edge in positionedEdges"
                :key="edge.id"
                :x1="edge.from.x" :y1="edge.from.y"
                :x2="edge.to.x" :y2="edge.to.y"
                :class="{ highlighted: selectedNode && (edge.raw.from === selectedNode.id || edge.raw.to === selectedNode.id) }"
                marker-end="url(#evolution-arrow)"
              />
              <text
                v-for="edge in positionedEdges"
                :key="`${edge.id}:label`"
                :x="(edge.from.x + edge.to.x) / 2"
                :y="(edge.from.y + edge.to.y) / 2 - 5"
                text-anchor="middle"
                :class="{ highlighted: selectedNode && (edge.raw.from === selectedNode.id || edge.raw.to === selectedNode.id) }"
              >{{ relationLabel(edge.raw.type) }}</text>
            </g>
            <g
              v-for="node in positionedNodes"
              :key="node.id"
              class="graph-node"
              :class="{ selected: selectedNode?.id === node.id, muted: selectedNode && selectedNode.id !== node.id && !neighborIds.has(node.id) }"
              :transform="`translate(${node.x - 68} ${node.y - 28})`"
              tabindex="0"
              role="button"
              @click="selectNode(node.raw)"
              @keyup.enter="selectNode(node.raw)"
            >
              <rect width="136" height="56" rx="5" :fill="typeMeta(node.raw.type).color" />
              <text x="68" y="21" text-anchor="middle" class="node-type">{{ typeMeta(node.raw.type).short }}</text>
              <text x="68" y="41" text-anchor="middle" class="node-label">{{ truncate(node.raw.label, 15) }}</text>
            </g>
          </svg>
        </section>

        <aside class="inspector">
          <template v-if="selectedNode">
            <div class="inspector-type" :style="{ color: typeMeta(selectedNode.type).color }">
              {{ typeMeta(selectedNode.type).name }}
            </div>
            <h2>{{ selectedNode.label }}</h2>
            <p>{{ selectedNode.summary }}</p>

            <dl>
              <div><dt>状态</dt><dd>{{ selectedNode.state || '已验证' }}</dd></div>
              <div><dt>证据数量</dt><dd>{{ selectedNode.evidenceIds.length }}</dd></div>
              <div><dt>生效时间</dt><dd>{{ formatTime(selectedNode.validFrom) }}</dd></div>
              <div v-if="selectedNode.validTo"><dt>失效时间</dt><dd>{{ formatTime(selectedNode.validTo) }}</dd></div>
            </dl>

            <div class="evidence-block">
              <strong>证据引用</strong>
              <span v-for="id in selectedNode.evidenceIds" :key="id">{{ id }}</span>
            </div>

            <div v-if="Object.keys(selectedNode.data || {}).length" class="data-block">
              <strong>结构化信息</strong>
              <pre>{{ JSON.stringify(selectedNode.data, null, 2) }}</pre>
            </div>

            <button class="primary expand-button" :disabled="loading" @click="focusSelected">展开两层关系</button>
          </template>
          <div v-else class="inspector-empty">
            <strong>选择一个节点</strong>
            <span>这里会显示它的含义、状态、证据和适用信息。</span>
          </div>
        </aside>
      </div>
      </template>

      <section v-else-if="view === 'lineage'" class="analysis-layout">
        <div class="analysis-list">
          <div class="panel-title"><div><strong>具体任务经验</strong><span>先选“学会了什么”，再看内部版本</span></div></div>
          <button v-for="lineage in dashboard.experienceLineages" :key="lineage.id" class="policy-row experience-row" :class="{ active: selectedExperienceLineage?.id === lineage.id }" @click="selectExperienceLineage(lineage)">
            <span>经验：{{ lineage.goalPattern }}</span><strong>{{ lineage.versions.length ? `${lineage.versions.length} 版` : 'V0' }}</strong>
            <small>{{ lineage.taskFamily }} · {{ maturityLabel(lineage.maturity) }}</small>
          </button>
          <div v-if="!dashboard.experienceLineages.length" class="inline-empty">还没有可识别的任务经验。完成真实任务后，这里会按目标分别建立谱系。</div>
        </div>
        <div class="analysis-main">
          <template v-if="selectedExperienceLineage">
            <div class="panel-title lineage-heading">
              <div><strong>经验：{{ selectedExperienceLineage.goalPattern }}</strong><span>{{ selectedExperienceLineage.taskFamily }} · {{ selectedExperienceLineage.goalSignature || '旧数据暂无 GoalSignature' }}</span></div>
              <div class="lineage-facts"><span>候选 {{ selectedExperienceLineage.candidateId || '无' }}</span><span>候选代际 {{ selectedExperienceLineage.candidateGenerations?.length || 0 }}</span><span>来源 Episode {{ selectedExperienceLineage.sourceEpisodeIds.length }}</span><span>真实 PlanRun {{ selectedExperienceLineage.planRunIds.length }}</span></div>
            </div>
            <div v-if="selectedExperienceLineage.candidateGenerations?.length" class="version-strip candidate-generation-strip" aria-label="该经验的候选代际">
              <button v-for="generation in selectedExperienceLineage.candidateGenerations" :key="generation.id" :class="{ active: selectedCandidateGeneration?.id === generation.id }" :title="`${generation.id}\n${generation.contentHash}`" @click="selectedCandidateGenerationId = generation.id">
                <strong>G{{ generation.generation }}</strong><small>{{ generation.validationStatus || generation.status }} · 第 {{ generation.validationAttempt || 0 }} 次评测</small><small>成功 {{ generation.positiveEpisodeIds.length }} · 失败 {{ generation.negativeEpisodeIds.length }} · {{ shortHash(generation.contentHash) }}</small>
              </button>
            </div>
            <div v-if="selectedCandidateGeneration" class="candidate-source-grid">
              <div class="policy-content"><strong>G{{ selectedCandidateGeneration.generation }} 为什么产生</strong><ul><li v-for="change in selectedCandidateGeneration.changes" :key="change">{{ change }}</li></ul><span v-if="selectedCandidateGeneration.evolvedFromCandidateId">父代：{{ selectedCandidateGeneration.evolvedFromCandidateId }}</span><span v-else>这是该任务的初始候选代。</span></div>
              <div class="policy-content source-evidence"><strong>成功来源 Episode</strong><button v-for="episodeId in selectedCandidateGeneration.positiveEpisodeIds" :key="episodeId" @click="openEpisode(episodeId)">{{ episodeId }}</button><span v-if="!selectedCandidateGeneration.positiveEpisodeIds.length">本代没有成功来源。</span></div>
              <div class="policy-content source-evidence"><strong>失败来源 Episode</strong><button v-for="episodeId in selectedCandidateGeneration.negativeEpisodeIds" :key="episodeId" @click="openEpisode(episodeId)">{{ episodeId }}</button><span v-if="!selectedCandidateGeneration.negativeEpisodeIds.length">本代没有可学习失败。</span></div>
            </div>
            <div v-if="selectedExperienceLineage.validationRun" class="lineage-validation">
              <strong>候选评测 · 第 {{ selectedExperienceLineage.validationRun.attempt }} 次 · {{ selectedExperienceLineage.validationRun.status }}</strong>
              <span>Control {{ selectedExperienceLineage.validationRun.baselineEpisodeIds.length }}</span>
              <span>Selection {{ selectedExperienceLineage.validationRun.selectionEpisodeIds.length }}</span>
              <span>Hidden {{ selectedExperienceLineage.validationRun.hiddenEpisodeIds.length }}</span>
            </div>
            <div v-if="selectedExperienceLineage.versions.length" class="version-strip" aria-label="该经验的 Policy 版本">
              <button v-for="version in selectedExperienceLineage.versions" :key="version.policy.id" :class="{ active: selectedPolicy?.id === version.policy.id }" @click="selectedPolicy = version.policy">
                <strong>V{{ version.policy.version }}</strong><span>{{ version.policy.state }}</span><small>{{ percent(version.policy.confidenceLowerBound) }}</small>
              </button>
            </div>
            <template v-if="selectedPolicy">
            <div class="panel-title"><div><strong>V{{ selectedPolicy.version }} 指标与证据</strong><span>{{ selectedPolicy.id }} · revision {{ selectedPolicy.revision }}</span></div></div>
            <div class="curve-grid">
              <article v-for="point in selectedPolicyCurves" :key="point.id" :class="['curve-card', point.split]">
                <span>{{ point.split.toUpperCase() }}</span><strong>{{ percent(point.metrics.successRate) }}</strong>
                <div class="bar"><i :style="{ width: percent(point.metrics.successRate) }"></i></div>
                <small>{{ point.metrics.samples }} 样本 · 成功率 {{ percent(point.metrics.successRate) }}</small>
                <small>P50/P95：{{ point.metrics.medianDurationMs }}/{{ point.metrics.p95DurationMs ?? point.metrics.medianDurationMs }}ms · 动作 {{ point.metrics.medianActions }}/{{ point.metrics.p95Actions ?? point.metrics.medianActions }} · LLM {{ point.metrics.medianLlmRounds }}/{{ point.metrics.p95LlmRounds ?? point.metrics.medianLlmRounds }}</small>
                <small>无进展 {{ point.metrics.medianNoProgressActions ?? 0 }} · 恢复 {{ point.metrics.medianRecoveryCount ?? 0 }} · 重规划 {{ point.metrics.medianReplanCount ?? 0 }} · 非法动作 {{ point.metrics.medianInvalidActions ?? 0 }}</small>
                <small>主人介入 {{ percent(point.metrics.interventionRate) }} · 安全事件 {{ point.metrics.safetyViolations }}</small>
              </article>
              <div v-if="!selectedPolicyCurves.length" class="inline-empty compact">该版本尚未完成 Selection/Hidden 评测。</div>
            </div>
            <div class="policy-content"><strong>相对上一版的变化</strong><ul><li v-for="change in selectedLineageVersion?.changes || []" :key="change">{{ change }}</li></ul></div>
            <div class="policy-content"><strong>Policy 内容</strong><pre>{{ JSON.stringify(selectedPolicy.content, null, 2) }}</pre></div>
            <div class="policy-content source-evidence"><strong>来源 Episode</strong><button v-for="episodeId in selectedLineageVersion?.sourceEpisodeIds || []" :key="episodeId" @click="openEpisode(episodeId)">{{ episodeId }}</button><span v-if="!selectedLineageVersion?.sourceEpisodeIds?.length">旧版本没有可解析的 Episode 引用，仍保留原始 evidenceIds 供审计。</span></div>
            <div class="governance-actions">
              <button v-if="selectedPolicy.state === 'trusted'" class="danger" @click="govern('disable')">禁用此版本</button>
              <button v-if="selectedPolicy.trustedAt && selectedPolicy.state !== 'trusted' && selectedPolicy.state !== 'blacklisted'" @click="govern('rollback')">回滚到此版本</button>
              <span>治理只从下一次规划生效，不修改当前执行会话。</span>
            </div>
            <div class="audit-list"><strong>版本审计</strong><span v-for="audit in selectedPolicyAudit" :key="audit.id">{{ audit.action }} · {{ formatTime(audit.createdAt) }} · {{ JSON.stringify(audit.detail) }}</span></div>
            </template>
            <div v-else class="inline-empty lineage-progress"><strong>{{ maturityLabel(selectedExperienceLineage.maturity) }}</strong><span>真实运行 {{ selectedExperienceLineage.planRunIds.length }} 次，来源 Episode {{ selectedExperienceLineage.sourceEpisodeIds.length }} 个。</span><span>{{ lineageNextStep(selectedExperienceLineage) }}</span></div>
          </template>
          <div v-else class="inline-empty">选择左侧的一项具体任务经验，查看它如何从 Episode 演化为可信版本。</div>
        </div>
      </section>

      <section v-else-if="view === 'trajectory'" class="analysis-layout">
        <div class="analysis-list">
          <div class="panel-title"><div><strong>任务进化曲线</strong><span>同一父目标的每次真实运行</span></div></div>
          <button v-for="series in goalTrajectories" :key="series.key" class="policy-row" :class="{ active: selectedTrajectory?.key === series.key }" @click="selectTrajectorySeries(series)">
            <span>{{ series.goal }}</span><strong>{{ series.runs.length }} 次</strong><small>最近得分 {{ series.runs.at(-1)?.masteryScore ?? 0 }} · {{ series.runs.at(-1)?.outcome ?? '未知' }}</small>
          </button>
          <div v-if="!goalTrajectories.length" class="inline-empty">还没有带父 PlanGraph 的真实运行。</div>
        </div>
        <div class="analysis-main">
          <template v-if="selectedTrajectory">
            <div class="panel-title trajectory-title">
              <div><strong>{{ selectedTrajectory.goal }}</strong><span>{{ selectedTrajectoryMetric.help }}</span></div>
              <label>曲线指标
                <select v-model="trajectoryMetricId">
                  <option v-for="metric in trajectoryMetrics" :key="metric.id" :value="metric.id">{{ metric.label }}</option>
                </select>
              </label>
            </div>
            <svg class="trajectory-chart" viewBox="0 0 760 260" role="img" aria-label="任务进化量化曲线">
              <line x1="54" y1="220" x2="735" y2="220" />
              <line x1="54" y1="20" x2="54" y2="220" />
              <line v-for="level in trajectoryLevels.slice(1)" :key="level.ratio" x1="54" :y1="220-level.ratio*200" x2="735" :y2="220-level.ratio*200" class="grid-line" />
              <text v-for="level in trajectoryLevels" :key="`label-${level.ratio}`" x="45" :y="224-level.ratio*200" text-anchor="end">{{ formatMetricValue(level.value) }}</text>
              <polyline v-if="trajectoryPoints.length > 1" :points="trajectoryPolyline" />
              <g v-for="point in trajectoryPoints" :key="point.run.planRunId" class="trajectory-point">
                <circle :cx="point.x" :cy="point.y" r="7" :class="point.run.outcome" />
                <text :x="point.x" y="244" text-anchor="middle">#{{ point.run.runIndex }}</text>
                <title>第 {{ point.run.runIndex }} 次 · {{ selectedTrajectoryMetric.label }} {{ formatMetricValue(point.value) }}{{ selectedTrajectoryMetric.unit }} · {{ runOutcomeLabel(point.run.outcome) }}</title>
              </g>
            </svg>
            <div class="run-table-wrap">
              <table class="run-table">
                <thead><tr><th>轮次</th><th>结果</th><th>学习样本</th><th>得分</th><th>相对首轮</th><th>动作 提议/执行/失败</th><th>无进展</th><th>重规划/恢复</th><th>移动</th><th>LLM</th><th>耗时</th><th>经验快照</th><th>采用/舍弃</th><th>主人介入</th></tr></thead>
                <tbody><tr v-for="run in selectedTrajectory.runs" :key="run.planRunId"><td>#{{ run.runIndex }}<small v-if="run.isComparisonBaseline"> · 可比基线</small></td><td>{{ runOutcomeLabel(run.outcome) }}</td><td><span :title="run.learningExclusionReason || '可进入候选聚合'">{{ run.learningEligible ? '计入' : '排除' }}</span></td><td><strong>{{ run.masteryScore }}</strong></td><td>{{ signedPercent(run.improvementPct) }}</td><td>{{ run.actionCount }} / {{ run.executedActionCount }} / {{ run.failedActionCount }}</td><td>{{ run.noProgressActions }}</td><td>{{ run.replanCount }} / {{ run.recoveryCount }}</td><td>{{ Number(run.distanceMoved || 0).toFixed(1) }} 格</td><td>{{ run.llmRounds }}</td><td>{{ duration(run.durationMs) }}</td><td><span :title="`${run.bundleId || ''}\n${run.selectionManifestId || ''}`">{{ run.policySnapshotId || '冷启动' }}</span></td><td><span :title="experienceDecisionTitle(run)">{{ run.selectedExperience?.length || 0 }} / {{ run.rejectedExperience?.length || 0 }}</span></td><td>{{ run.intervention ? '是' : '否' }}</td></tr></tbody>
              </table>
            </div>
          </template>
          <div v-else class="inline-empty">选择一个父任务查看每轮进化轨迹。</div>
        </div>
      </section>

      <section v-else-if="view === 'episodes'" class="analysis-layout">
        <div class="analysis-list">
          <div class="panel-title"><div><strong>Episode</strong><span>不可变执行事实回放</span></div></div>
          <button v-for="episode in dashboard.episodes" :key="episode.id" class="policy-row" :class="{ active: selectedEpisode?.id === episode.id }" @click="selectedEpisode = episode">
            <span>{{ episode.outcome || 'unknown' }} · {{ episode.hidden ? 'Hidden 已脱敏' : episode.attribution.category }}</span><strong>{{ episode.actionCount }} 动作</strong><small>{{ episode.hidden ? 'Hidden 评测样本' : episode.id }}</small>
          </button>
          <div v-if="!dashboard.episodes.length" class="inline-empty">还没有封账 Episode。</div>
        </div>
        <div class="analysis-main">
          <template v-if="selectedEpisode">
            <div class="panel-title"><div><strong>Episode 回放 · {{ selectedEpisode.hidden ? 'Hidden 评测样本' : selectedEpisode.id }}</strong><span>{{ selectedEpisode.attribution.reason }}</span></div></div>
            <ol class="timeline">
              <li v-for="event in selectedEpisode.timeline" :key="`${event.sequence}:${event.eventType}`"><i>{{ event.sequence }}</i><div><strong>{{ event.eventType }}</strong><small>{{ formatTime(event.occurredAt) }}</small><pre>{{ JSON.stringify(event.payload, null, 2) }}</pre></div></li>
            </ol>
          </template>
          <div v-else class="inline-empty">选择一个 Episode 查看计划、动作、观察、失败与恢复事实。</div>
        </div>
      </section>

      <section v-else class="agenda-grid">
        <article v-for="item in activeAgenda" :key="item.candidateId" class="agenda-card">
          <div><span>{{ item.status }}</span><strong>{{ candidateLabel(item.candidateId) }}</strong></div>
          <dl><div><dt>信息增益</dt><dd>{{ number(item.expectedInformationGain) }}</dd></div><div><dt>不确定度</dt><dd>{{ percent(item.uncertainty) }}</dd></div><div><dt>影响范围</dt><dd>{{ number(item.impactScope) }}</dd></div><div><dt>Headroom</dt><dd>{{ percent(item.headroom) }}</dd></div><div><dt>成本 / 风险</dt><dd>{{ number(item.estimatedCost) }} / {{ number(item.safetyRisk) }}</dd></div><div><dt>重试预算</dt><dd>{{ item.retryBudget }}</dd></div></dl>
          <small>{{ item.reason || item.validationSpec?.validatorId || '等待调度' }}</small>
          <div v-if="validationRun(item.candidateId)" class="validation-progress">
            <strong>第 {{ validationRun(item.candidateId).attempt }} 次评测 · {{ validationRun(item.candidateId).status }}</strong>
            <span>Control {{ validationRun(item.candidateId).baselineEpisodeIds.length }}</span>
            <span>Selection {{ validationRun(item.candidateId).selectionEpisodeIds.length }}/{{ item.validationSpec?.minimumSelectionSamples ?? 0 }}</span>
            <span>Hidden {{ validationRun(item.candidateId).hiddenEpisodeIds.length }}/{{ item.validationSpec?.minimumHiddenSamples ?? 0 }}</span>
            <small>已消费且不可复用 {{ validationRun(item.candidateId).consumedTrialEpisodeIds.length }} 个 Treatment Episode</small>
          </div>
        </article>
        <div v-if="!activeAgenda.length" class="empty-state">当前没有可验证的研究候选。</div>
      </section>
    </template>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { disableEvolutionPolicy, downloadEvolutionAudit, fetchEvolutionDashboard, fetchEvolutionGraph, fetchEvolutionSummary, rollbackEvolutionPolicy } from '../lib/plannerEvolutionApi.js';

const props = defineProps({ botId: { type: String, default: '' } });
const views = [
  { id: 'capability', name: '能力图谱', hint: '学会了什么' },
  { id: 'lineage', name: '进化谱系', hint: '为何升级' },
  { id: 'trajectory', name: '任务进化', hint: '每轮是否更熟练' },
  { id: 'episodes', name: 'Episode 回放', hint: '发生了什么' },
  { id: 'agenda', name: '研究议程', hint: '下一步学什么' },
];

const nodeTypes = [
  { id: 'goal_pattern', name: '目标模式', short: '目标', color: '#5f8fbe', column: 0 },
  { id: 'task_schema', name: '任务结构', short: '结构', color: '#8b6fbd', column: 1 },
  { id: 'plan_graph', name: '实际计划图', short: '计划', color: '#5a7fa8', column: 2 },
  { id: 'plan_node', name: '实际计划节点', short: '节点', color: '#6b8e5a', column: 3 },
  { id: 'plan_fragment', name: '计划片段', short: '片段', color: '#5e9b70', column: 2 },
  { id: 'plan_recovery_pattern', name: '恢复模式', short: '恢复', color: '#b68a45', column: 3 },
  { id: 'meta_policy', name: '规划元策略', short: '元策略', color: '#8c7650', column: 2 },
  { id: 'failure_pattern', name: '失败模式', short: '失败', color: '#b45d52', column: 3 },
  { id: 'policy', name: '规划 Policy', short: 'Policy', color: '#4f9da6', column: 4 },
  { id: 'candidate', name: '候选经验', short: '候选', color: '#a98548', column: 4 },
  { id: 'episode', name: 'Episode', short: '运行', color: '#6d7b8c', column: 5 },
  { id: 'evidence', name: '评测证据', short: '证据', color: '#7f8f54', column: 5 },
  { id: 'context', name: '适用情境', short: '情境', color: '#8b7865', column: 1 },
  { id: 'selection_manifest', name: '选择清单', short: '选择', color: '#7565a5', column: 4 },
  { id: 'experience_rejection', name: '舍弃经验', short: '舍弃', color: '#9a665c', column: 4 },
];
const knowledgeGraphTypeIds = nodeTypes
  .filter(item => !['episode', 'evidence', 'plan_graph', 'plan_node'].includes(item.id))
  .map(item => item.id)
  .join(',');

const summary = ref(null);
const graph = ref({ nodes: [], edges: [], truncated: false });
const loading = ref(false);
const error = ref('');
const search = ref('');
const type = ref('');
const selectedNode = ref(null);
const focusedRoot = ref('');
const view = ref('capability');
const dashboard = ref({ runtimeGate: null, policies: [], policyAudit: [], candidates: [], agenda: [], validationRuns: [], curves: [], experimentAllocations: [], experienceLineages: [], planRuns: [], episodes: [] });
const selectedExperienceLineage = ref(null);
const selectedCandidateGenerationId = ref('');
const selectedPolicy = ref(null);
const selectedEpisode = ref(null);
const selectedTrajectory = ref(null);
const trajectoryMetricId = ref('masteryScore');
const trajectoryMetrics = [
  { id:'masteryScore', label:'综合得分', unit:' 分', help:'综合成功、动作、耗时、LLM 轮数和主人介入；越高越好', value:run => Number(run.masteryScore || 0), fixedMax:100 },
  { id:'completionRate', label:'里程碑完成率', unit:'%', help:'已完成计划节点占比；越高越好', value:run => run.nodeCount > 0 ? Number(run.completedNodes || 0) / Number(run.nodeCount) * 100 : 0, fixedMax:100 },
  { id:'executedActionCount', label:'执行动作', unit:' 次', help:'真正执行的动作数；同样成功时越低越熟练', value:run => Number(run.executedActionCount || 0) },
  { id:'failedActionCount', label:'失败动作', unit:' 次', help:'执行失败的动作数；越低越稳定', value:run => Number(run.failedActionCount || 0) },
  { id:'llmRounds', label:'LLM 轮数', unit:' 轮', help:'规划与决策调用轮数；同样成功时越低越高效', value:run => Number(run.llmRounds || 0) },
  { id:'durationMinutes', label:'耗时', unit:' 分钟', help:'任务实际耗时；同样成功时越低越快', value:run => Number(run.durationMs || 0) / 60_000 },
  { id:'distanceMoved', label:'移动距离', unit:' 格', help:'累计移动距离；用于识别绕路和资源定位低效', value:run => Number(run.distanceMoved || 0) },
];

watch(() => props.botId, () => {
  summary.value = null;
  graph.value = { nodes: [], edges: [], truncated: false };
  selectedNode.value = null;
  focusedRoot.value = '';
  view.value = 'capability';
  dashboard.value = { runtimeGate: null, policies: [], policyAudit: [], candidates: [], agenda: [], validationRuns: [], curves: [], experimentAllocations: [], experienceLineages: [], planRuns: [], episodes: [] };
  selectedExperienceLineage.value = null;
  selectedCandidateGenerationId.value = '';
  selectedPolicy.value = null;
  selectedEpisode.value = null;
  selectedTrajectory.value = null;
  error.value = '';
  if (props.botId) void refresh();
}, { immediate: true });

const positionedNodes = computed(() => {
  const groups = new Map();
  for (const node of graph.value.nodes) {
    const column = typeMeta(node.type).column;
    if (!groups.has(column)) groups.set(column, []);
    groups.get(column).push(node);
  }
  const result = [];
  for (const [column, nodes] of groups) {
    nodes.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
    const gap = 82;
    const start = 72;
    nodes.forEach((node, index) => result.push({
      id: node.id,
      x: 100 + column * 180,
      y: start + index * gap,
      raw: node,
    }));
  }
  return result;
});

const canvasHeight = computed(() => {
  const counts = new Map();
  for (const node of graph.value.nodes) {
    const column = typeMeta(node.type).column;
    counts.set(column, (counts.get(column) || 0) + 1);
  }
  return Math.max(650, 140 + Math.max(0, ...counts.values()) * 82);
});

const positionMap = computed(() => new Map(positionedNodes.value.map(node => [node.id, node])));
const positionedEdges = computed(() => graph.value.edges
  .map(edge => ({ id: edge.id, raw: edge, from: positionMap.value.get(edge.from), to: positionMap.value.get(edge.to) }))
  .filter(edge => edge.from && edge.to));
const neighborIds = computed(() => {
  if (!selectedNode.value) return new Set();
  const ids = new Set([selectedNode.value.id]);
  for (const edge of graph.value.edges) {
    if (edge.from === selectedNode.value.id) ids.add(edge.to);
    if (edge.to === selectedNode.value.id) ids.add(edge.from);
  }
  return ids;
});
const visibleLegend = computed(() => nodeTypes.filter(item => graph.value.nodes.some(node => node.type === item.id)));
const selectedPolicyCurves = computed(() => selectedPolicy.value ? dashboard.value.curves.filter(point => point.policyId === selectedPolicy.value.id) : []);
const selectedPolicyAudit = computed(() => selectedPolicy.value ? dashboard.value.policyAudit.filter(item => item.policyId === selectedPolicy.value.id) : []);
const selectedLineageVersion = computed(() => selectedExperienceLineage.value?.versions?.find(version => version.policy.id === selectedPolicy.value?.id) || null);
const selectedCandidateGeneration = computed(() => selectedExperienceLineage.value?.candidateGenerations?.find(generation => generation.id === selectedCandidateGenerationId.value)
  ?? selectedExperienceLineage.value?.candidateGenerations?.at(-1)
  ?? null);
const activeAgenda = computed(() => dashboard.value.agenda.filter(item => item.reason !== 'candidate_superseded_by_canonicalization'));
const trustedLineageCount = computed(() => dashboard.value.experienceLineages.filter(item => item.currentPolicyId).length);
const evolutionStatusText = computed(() => {
  if ((summary.value?.counts?.knowledgeNodes || 0) > 0) return '● 经验图谱已建立';
  if (summary.value?.available) return '◐ 已有证据，尚未形成经验';
  return '○ 等待首批经验';
});
const experimentGateTitle = computed(() => dashboard.value.runtimeGate?.candidateTrialsEnabled
  ? '已开启，将在下一次同类任务使用冻结 Candidate'
  : '未开启，Candidate 只会积累证据，不会自行晋升');
const experimentGateDetail = computed(() => ({
  evolution_not_active:'PLANNER_EVOLUTION_MODE 不是 active，生产规划不会采用经验或候选实验。',
  experiment_not_authorized:'PLANNER_EXPERIMENT_MODE 尚未授权，普通任务不会进入 Selection/Hidden。',
  profile_not_allowlisted:'当前角色不在 PLANNER_EXPERIMENT_PROFILE_IDS 白名单中。',
  authorized:'实验仅对当前授权角色生效；每轮仍须通过上下文可比、样本预算和安全硬门。',
})[dashboard.value.runtimeGate?.reason] || '尚未读取到进化运行门状态。');
const goalTrajectories = computed(() => {
  const groups = new Map();
  for (const run of dashboard.value.planRuns || []) {
    const key = run.goalSignature || String(run.parentGoalText || '').toLowerCase().replace(/[\s，。！？、；：,.!?;:]+/g, '');
    if (!groups.has(key)) groups.set(key, { key, goal: run.parentGoalText, runs: [] });
    groups.get(key).runs.push(run);
  }
  return [...groups.values()].sort((a, b) => b.runs.length - a.runs.length);
});
const selectedTrajectoryMetric = computed(() => trajectoryMetrics.find(metric => metric.id === trajectoryMetricId.value) || trajectoryMetrics[0]);
const trajectoryScaleMax = computed(() => {
  if (selectedTrajectoryMetric.value.fixedMax) return selectedTrajectoryMetric.value.fixedMax;
  const values = (selectedTrajectory.value?.runs || []).map(run => selectedTrajectoryMetric.value.value(run));
  return Math.max(1, Math.ceil(Math.max(1, ...values) * 1.1));
});
const trajectoryLevels = computed(() => [0, .25, .5, .75, 1].map(ratio => ({ ratio, value:trajectoryScaleMax.value * ratio })));
const trajectoryPoints = computed(() => {
  const runs = selectedTrajectory.value?.runs || [];
  const width = 660;
  return runs.map((run, index) => {
    const value = selectedTrajectoryMetric.value.value(run);
    return {
      run,
      value,
      x: 74 + (runs.length <= 1 ? 0 : index * width / (runs.length - 1)),
      y: 220 - Math.max(0, Math.min(1, value / trajectoryScaleMax.value)) * 200,
    };
  });
});
const trajectoryPolyline = computed(() => trajectoryPoints.value.map(point => `${point.x},${point.y}`).join(' '));

function experienceDecisionTitle(run) {
  const selected = (run.selectedExperience || []).map(item => `采用 ${item.experienceId}: ${(item.reasons || []).join('、')}`);
  const rejected = (run.rejectedExperience || []).map(item => `舍弃 ${item.experienceId}: ${item.reason}`);
  return [...selected, ...rejected].join('\n') || '本轮没有适用经验，使用冷启动规划';
}

function formatMetricValue(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function maturityLabel(value) { return ({ observed:'已观察', accumulating:'积累证据中', candidate:'候选待评测', evaluating:'评测中', trusted:'可信经验' })[value] || '已观察'; }
function lineageNextStep(lineage) {
  if (lineage.maturity === 'observed') return '本轮尚未形成可归因终态；完成或结构化失败后才能进入学习。';
  if (lineage.maturity === 'accumulating') return '正在聚合成功里程碑和规划失败证据，达到条件后生成 Candidate。';
  if (lineage.maturity === 'candidate' && !dashboard.value.runtimeGate?.candidateTrialsEnabled) return experimentGateDetail.value;
  if (lineage.maturity === 'candidate') return '运行门已开启；下一次上下文可比的同类任务将依次形成 Selection 与 Hidden 真服样本。';
  if (lineage.maturity === 'evaluating') return '候选正在经过严格改善与安全零回归 Gate。';
  return '后续同类任务将优先检索该可信版本，并继续监控回归。';
}

async function exportAudit() {
  if (!props.botId) return;
  loading.value = true; error.value = '';
  try {
    if (view.value === 'lineage' && selectedPolicy.value) await downloadEvolutionAudit(props.botId, 'policy', selectedPolicy.value.id);
    else if (view.value === 'trajectory' && selectedTrajectory.value?.runs?.length) await downloadEvolutionAudit(props.botId, 'plan_run', selectedTrajectory.value.runs.at(-1).planRunId);
    else if (view.value === 'episodes' && selectedEpisode.value) await downloadEvolutionAudit(props.botId, 'episode', selectedEpisode.value.id);
    else await downloadEvolutionAudit(props.botId, 'full');
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '导出审计包失败'; }
  finally { loading.value = false; }
}

async function refresh() {
  if (!props.botId) return;
  loading.value = true;
  error.value = '';
  try {
    const [nextSummary, nextGraph, nextDashboard] = await Promise.all([
      fetchEvolutionSummary(props.botId),
      fetchEvolutionGraph(props.botId, { type:knowledgeGraphTypeIds, maxNodes: 160, maxEdges: 320 }),
      fetchEvolutionDashboard(props.botId),
    ]);
    summary.value = nextSummary;
    graph.value = nextGraph;
    dashboard.value = nextDashboard;
    const currentLineageId = selectedExperienceLineage.value?.id;
    selectedExperienceLineage.value = nextDashboard.experienceLineages.find(lineage => lineage.id === currentLineageId) ?? nextDashboard.experienceLineages[0] ?? null;
    selectExperienceLineage(selectedExperienceLineage.value);
    selectedEpisode.value = nextDashboard.episodes.at(-1) ?? null;
    const currentTrajectoryKey = selectedTrajectory.value?.key;
    selectedTrajectory.value = goalTrajectories.value.find(series => series.key === currentTrajectoryKey) ?? goalTrajectories.value[0] ?? null;
    selectedNode.value = null;
    focusedRoot.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取进化图谱失败';
  } finally {
    loading.value = false;
  }
}

async function loadOverview() {
  if (!props.botId) return;
  loading.value = true;
  error.value = '';
  try {
    graph.value = await fetchEvolutionGraph(props.botId, {
      type: type.value || knowledgeGraphTypeIds,
      search: search.value.trim(),
      maxNodes: 160,
      maxEdges: 320,
    });
    selectedNode.value = null;
    focusedRoot.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取进化图谱失败';
  } finally {
    loading.value = false;
  }
}

function selectNode(node) {
  selectedNode.value = node;
}

function selectExperienceLineage(lineage) {
  selectedExperienceLineage.value = lineage || null;
  if (!lineage) { selectedPolicy.value = null; selectedCandidateGenerationId.value = ''; return; }
  selectedCandidateGenerationId.value = lineage.candidateGenerations?.at(-1)?.id || '';
  selectedPolicy.value = lineage.versions.find(version => version.policy.id === lineage.currentPolicyId)?.policy
    ?? lineage.versions.at(-1)?.policy
    ?? null;
  const trajectory = goalTrajectories.value.find(series => series.key === lineage.goalSignature)
    ?? goalTrajectories.value.find(series => lineage.planRunIds.includes(series.runs.at(-1)?.planRunId));
  if (trajectory) selectedTrajectory.value = trajectory;
}

function openEpisode(episodeId) {
  const episode = dashboard.value.episodes.find(item => item.id === episodeId);
  if (!episode) return;
  const lineage = dashboard.value.experienceLineages.find(item => item.planRunIds.includes(episode.planRunId));
  if (lineage) selectExperienceLineage(lineage);
  selectedEpisode.value = episode;
  view.value = 'episodes';
}

function selectExperienceById(event) {
  const id = event?.target?.value || '';
  selectExperienceLineage(dashboard.value.experienceLineages.find(item => item.id === id) || null);
}

function selectTrajectorySeries(series) {
  selectedTrajectory.value = series;
  const lineage = dashboard.value.experienceLineages.find(item => item.goalSignature === series.key)
    ?? dashboard.value.experienceLineages.find(item => item.planRunIds.some(id => series.runs.some(run => run.planRunId === id)));
  if (lineage && selectedExperienceLineage.value?.id !== lineage.id) selectExperienceLineage(lineage);
}

async function focusSelected() {
  if (!props.botId || !selectedNode.value) return;
  const root = selectedNode.value.id;
  loading.value = true;
  error.value = '';
  try {
    graph.value = await fetchEvolutionGraph(props.botId, { root, depth: 2, maxNodes: 160, maxEdges: 320 });
    focusedRoot.value = root;
    selectedNode.value = graph.value.nodes.find(node => node.id === root) ?? null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '展开经验子图失败';
  } finally {
    loading.value = false;
  }
}

async function viewSelectedExperienceGraph() {
  if (!props.botId || !selectedExperienceLineage.value) return;
  const lineage = selectedExperienceLineage.value;
  const root = lineage.currentPolicyId ? `policy:${lineage.currentPolicyId}` : lineage.candidateId;
  if (!root) return;
  loading.value = true; error.value = '';
  try {
    view.value = 'capability';
    graph.value = await fetchEvolutionGraph(props.botId, { root, type:knowledgeGraphTypeIds, depth: 3, maxNodes: 160, maxEdges: 320 });
    focusedRoot.value = root;
    selectedNode.value = graph.value.nodes.find(node => node.id === root) ?? null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取具体经验子图失败';
  } finally { loading.value = false; }
}

function resetOverview() {
  void loadOverview();
}

async function govern(action) {
  if (!selectedPolicy.value) return;
  const reason = window.prompt(action === 'disable' ? '请输入禁用原因' : '请输入回滚原因');
  if (!reason?.trim()) return;
  if (!window.confirm('该操作只从下一次规划生效，当前执行会话不会改变。确认继续？')) return;
  loading.value = true; error.value = '';
  try {
    const call = action === 'disable' ? disableEvolutionPolicy : rollbackEvolutionPolicy;
    await call(props.botId, selectedPolicy.value.id, selectedPolicy.value.revision, reason.trim());
    await refresh(); view.value = 'lineage';
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Policy 治理失败'; }
  finally { loading.value = false; }
}

function candidateLabel(id) { return dashboard.value.candidates.find(item => item.id === id)?.goalPattern || id; }
function validationRun(id) { return dashboard.value.validationRuns.find(item => item.candidateId === id) || null; }
function number(value) { return Number(value || 0).toFixed(2); }
function runOutcomeLabel(value) { return ({ succeeded:'成功', failed:'失败', cancelled:'已取消', incomplete:'进行中' })[value] || value; }
function signedPercent(value) { const n = Number(value || 0); return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`; }
function duration(value) { const seconds = Math.round(Number(value || 0) / 1000); return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`; }

function typeMeta(nodeType) {
  return nodeTypes.find(item => item.id === nodeType)
    || { id: nodeType, name: nodeType, short: nodeType, color: '#727b68', column: 5 };
}

function relationLabel(value) {
  return ({
    contains:'包含',proposes:'提出',evolved_from:'演化自',learned_from_success:'来源于成功',learned_from_failure:'来源于失败',
    handles:'处理失败',supports:'支持',refutes:'反证',planned_with:'规划采用',used_experience:'节点采用',selected:'选择',
    rejected_experience:'舍弃',supported_by:'证据支持',attempted:'尝试目标',executed_under:'执行计划',compiled_from:'编译自',
  })[value] || value;
}

function percent(value) { return `${Math.round(Number(value || 0) * 100)}%`; }
function shortHash(value) { const text = String(value || ''); return text ? text.slice(0, 10) : '无快照'; }
function truncate(value, max) { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function formatTime(value) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
</script>

<style scoped>
.evolution-shell { position:relative; z-index:2; flex:1; min-height:0; overflow:auto; padding:22px; background:#15170f; color:#e7e3d4; }
.trajectory-chart { width:100%; min-height:280px; margin:14px 0; background:#1b1e14; border:2px solid #343b2b; }
.trajectory-title { align-items:flex-end; }
.trajectory-title label { display:flex; align-items:center; gap:8px; color:#aeb99b; font-size:12px; }
.trajectory-title select { min-width:140px; }
.trajectory-chart line { stroke:#68705c; stroke-width:1.5; }
.trajectory-chart .grid-line { stroke:#343b2b; stroke-dasharray:5 5; }
.trajectory-chart polyline { fill:none; stroke:#8fb66f; stroke-width:4; stroke-linejoin:round; stroke-linecap:round; }
.trajectory-chart text { fill:#aaa88f; font-size:11px; }
.trajectory-point circle { fill:#6d7b8c; stroke:#15170f; stroke-width:3; }
.trajectory-point circle.succeeded { fill:#6b9a62; }
.trajectory-point circle.failed { fill:#b45d52; }
.run-table-wrap { overflow:auto; border:2px solid #343b2b; }
.run-table { width:100%; border-collapse:collapse; min-width:920px; background:#1b1e14; }
.run-table th,.run-table td { padding:10px 12px; text-align:left; border-bottom:1px solid #343b2b; white-space:nowrap; }
.run-table th { color:#aaa88f; font-size:11px; background:#20251a; }
.run-table td { font-size:12px; }
.evolution-header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; padding:20px; background:#20251a; border:3px solid #0c0e08; box-shadow:inset 2px 2px 0 rgba(255,255,255,.05),0 6px 0 rgba(0,0,0,.35); }
.eyebrow { color:#8fb66f; font-family:var(--mc-font-pixel); font-size:10px; }
h1 { margin:10px 0 6px; font-family:var(--mc-font-pixel); font-size:18px; color:#f2f0df; }
p { margin:0; color:#aeb4a0; line-height:1.55; }
.header-actions,.toolbar,.legend { display:flex; align-items:center; gap:9px; }
.header-actions { flex-wrap:wrap; justify-content:flex-end; }
button,select,input { font:inherit; color:#e7e3d4; background:#272d1d; border:2px solid #0d0f0a; box-shadow:inset 1px 1px 0 rgba(255,255,255,.06),inset -2px -2px 0 rgba(0,0,0,.35); }
button { padding:9px 13px; cursor:pointer; font-weight:700; }
button:disabled { cursor:not-allowed; opacity:.45; }
button.primary { background:#4c7a2a; border-color:#2b5e16; }
.freshness { padding:8px 10px; border:2px solid #0d0f0a; font-size:12px; font-weight:700; }
.freshness.ready { color:#b7e99b; background:#263a1d; }
.freshness.empty { color:#d5ba7b; background:#3a321d; }
.kpi-grid { display:grid; grid-template-columns:repeat(4,minmax(150px,1fr)); gap:12px; margin:18px 0 12px; }
.kpi-grid article { padding:15px; background:#20251a; border:2px solid #0c0e08; box-shadow:inset 1px 1px 0 rgba(255,255,255,.05),0 4px 0 rgba(0,0,0,.25); }
.kpi-grid span,.kpi-grid small { display:block; color:#8e9681; }
.kpi-grid strong { display:block; margin:8px 0 5px; color:#f0eddc; font-family:var(--mc-font-mono); font-size:25px; }
.kpi-grid small { font-size:11px; }
.policy-card { border-color:#365f5d !important; }
.view-tabs { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; margin:12px 0; }
.view-tabs button { display:flex; flex-direction:column; gap:4px; align-items:flex-start; padding:12px 14px; color:#aeb4a0; }
.view-tabs button.active { color:#f2efdd; background:#3d6127; border-color:#5c8d3b; }
.view-tabs small { color:#858e78; font-size:10px; }
.task-context { display:flex; align-items:center; justify-content:space-between; gap:18px; margin:12px 0; padding:13px 15px; background:#20251a; border:2px solid #4d633d; box-shadow:inset 1px 1px 0 rgba(255,255,255,.05); }
.task-context div { min-width:0; }
.task-context span,.task-context strong,.task-context small { display:block; }
.task-context span { color:#9dcc7d; font-size:10px; font-family:var(--mc-font-pixel); }
.task-context strong { margin:6px 0 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.task-context small { color:#8e9681; }
.task-context select { min-width:260px; max-width:42%; padding:10px; }
.experiment-gate { display:flex; align-items:center; justify-content:space-between; gap:18px; margin:0 0 12px; padding:12px 15px; background:#33291b; border:2px solid #765b2d; }
.experiment-gate.ready { background:#1d3220; border-color:#507644; }
.experiment-gate span,.experiment-gate strong,.experiment-gate small { display:block; }
.experiment-gate>div:first-child span { color:#d3b55d; font-family:var(--mc-font-pixel); font-size:9px; }
.experiment-gate.ready>div:first-child span { color:#9dcc7d; }
.experiment-gate strong { margin:5px 0; }
.experiment-gate small { color:#a9a18b; }
.gate-facts { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; }
.gate-facts span { padding:5px 7px; color:#c9c3ac; background:#12150e; border:1px solid #484332; font-family:var(--mc-font-mono); font-size:10px; }
.toolbar { padding:12px; background:#1b1e14; border:2px solid #0c0e08; }
.toolbar input { flex:1; min-width:180px; padding:10px 12px; background:#0c0e08; }
.toolbar select { padding:10px; }
.result-count { margin-left:auto; color:#89917d; font-family:var(--mc-font-mono); }
.notice { margin-top:12px; padding:10px 12px; border:2px solid #0d0f0a; }
.notice.error { background:#47221e; color:#ffc0b8; }
.empty-state { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; min-height:220px; margin-top:16px; padding:30px; text-align:center; color:#8f9682; background:#1b1e14; border:2px dashed #343a2b; }
.empty-state strong { color:#d9ddcf; font-size:16px; }
.empty-icon { display:grid; place-items:center; width:54px; height:54px; border:2px solid #4c7a2a; color:#9dcc7d; font-size:30px; }
.workspace { display:grid; grid-template-columns:minmax(0,1fr) 310px; gap:12px; margin-top:12px; min-height:560px; }
.graph-panel,.inspector { background:#1b1e14; border:2px solid #0c0e08; box-shadow:inset 1px 1px 0 rgba(255,255,255,.04); }
.panel-title { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:13px 15px; border-bottom:2px solid #0c0e08; }
.panel-title strong,.panel-title span { display:block; }
.panel-title span { margin-top:4px; color:#7f8774; font-size:11px; }
.legend { flex-wrap:wrap; justify-content:flex-end; }
.legend span { display:flex; align-items:center; gap:4px; margin:0; font-size:10px; }
.legend i { width:8px; height:8px; }
.graph-canvas { display:block; width:100%; min-height:500px; background-color:#12150e; background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px); background-size:26px 26px; }
.edges line { stroke:#505847; stroke-width:2; opacity:.75; }
.edges line.highlighted { stroke:#d3b55d; stroke-width:3; opacity:1; }
.edges text { fill:#858e78; font-size:9px; paint-order:stroke; stroke:#12150e; stroke-width:4px; stroke-linejoin:round; }
.edges text.highlighted { fill:#f0cf70; font-weight:800; }
.graph-node { cursor:pointer; outline:none; transition:opacity .15s; }
.graph-node rect { stroke:#0a0c08; stroke-width:3; filter:drop-shadow(0 4px 0 rgba(0,0,0,.35)); }
.graph-node.selected rect { stroke:#f3d875; stroke-width:5; }
.graph-node.muted { opacity:.32; }
.node-type { fill:rgba(255,255,255,.72); font-size:9px; font-weight:700; }
.node-label { fill:#fff; font-size:12px; font-weight:800; }
.inspector { padding:18px; overflow:auto; }
.inspector-type { font-family:var(--mc-font-pixel); font-size:10px; }
.inspector h2 { margin:12px 0 8px; color:#f2efdd; font-size:19px; }
.inspector dl { margin:18px 0; border-top:1px solid #343a2b; }
.inspector dl div { display:flex; justify-content:space-between; gap:10px; padding:9px 0; border-bottom:1px solid #343a2b; }
.inspector dt { color:#808873; }
.inspector dd { margin:0; text-align:right; color:#d8ddcd; }
.evidence-block,.data-block { display:flex; flex-direction:column; gap:7px; margin-top:16px; padding:12px; background:#12150e; border:2px solid #0c0e08; }
.evidence-block span { color:#aeb99b; font-family:var(--mc-font-mono); font-size:12px; overflow-wrap:anywhere; }
.data-block pre { max-height:210px; margin:0; overflow:auto; color:#aeb99b; font-size:11px; white-space:pre-wrap; }
.expand-button { width:100%; margin-top:16px; }
.inspector-empty { display:flex; min-height:300px; flex-direction:column; align-items:center; justify-content:center; gap:8px; text-align:center; color:#818975; }
.inspector-empty strong { color:#cfd5c3; }
.analysis-layout { display:grid; grid-template-columns:300px minmax(0,1fr); gap:12px; min-height:540px; }
.analysis-list,.analysis-main { background:#1b1e14; border:2px solid #0c0e08; }
.policy-row { display:grid; grid-template-columns:1fr auto; width:calc(100% - 16px); margin:8px; text-align:left; }
.policy-row.active { background:#3d6127; border-color:#6b984c; }
.policy-row small { grid-column:1/-1; margin-top:4px; color:#8f9682; overflow-wrap:anywhere; }
.experience-row span { font-weight:800; color:#e7e3d4; }
.lineage-heading { align-items:center; }
.lineage-facts { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; }
.lineage-facts span { margin:0; padding:5px 7px; color:#aeb99b; background:#12150e; border:1px solid #343a2b; }
.lineage-validation { display:grid; grid-template-columns:1fr repeat(3,auto); gap:10px; align-items:center; margin:14px; padding:12px; background:#12150e; border:2px solid #303727; }
.lineage-validation span { color:#aeb99b; font-family:var(--mc-font-mono); font-size:11px; }
.version-strip { display:flex; gap:8px; padding:0 14px 14px; overflow:auto; }
.version-strip button { display:grid; min-width:118px; grid-template-columns:1fr auto; text-align:left; }
.version-strip button strong { font-size:16px; }.version-strip button small { grid-column:1/-1; color:#8f9682; }
.version-strip button.active { background:#3d6127; border-color:#6b984c; }
.candidate-generation-strip button { display:grid; min-width:190px; gap:4px; padding:9px 11px; text-align:left; color:#d4ddc5; background:#12150e; border:2px solid #343a2b; font-family:var(--mc-font-mono); }
.candidate-generation-strip button.active { background:#3d6127; border-color:#6b984c; }
.candidate-generation-strip small { color:#8f9682; }
.candidate-source-grid { display:grid; grid-template-columns:1.2fr 1fr 1fr; gap:10px; margin:0 14px 14px; }
.candidate-source-grid .policy-content { margin:0; }
.inline-empty { display:grid; place-items:center; min-height:180px; padding:20px; color:#8f9682; text-align:center; }
.inline-empty.compact { min-height:90px; grid-column:1/-1; }
.curve-grid { display:grid; grid-template-columns:repeat(3,minmax(160px,1fr)); gap:10px; padding:14px; }
.curve-card { padding:14px; background:#12150e; border:2px solid #303727; }
.curve-card.selection { border-color:#72713f; }.curve-card.hidden { border-color:#694b76; }.curve-card.train { border-color:#3d6f58; }
.curve-card span,.curve-card small { display:block; color:#8f9682; }.curve-card strong { display:block; margin:8px 0; font-size:24px; }
.bar { height:8px; margin:8px 0; background:#292e23; }.bar i { display:block; height:100%; background:#8fb66f; }
.policy-content,.audit-list { display:flex; flex-direction:column; gap:7px; margin:0 14px 14px; padding:12px; background:#12150e; border:2px solid #0c0e08; }
.policy-content pre { max-height:260px; overflow:auto; color:#aeb99b; white-space:pre-wrap; }
.policy-content ul { margin:0; padding-left:20px; color:#c6cfb7; }.policy-content li+li { margin-top:5px; }
.source-evidence { align-items:flex-start; }.source-evidence button { padding:5px 8px; font-family:var(--mc-font-mono); font-size:var(--mc-type-body); }.source-evidence span { color:#8f9682; }
.governance-actions { display:flex; align-items:center; gap:10px; margin:14px; flex-wrap:wrap; }.governance-actions span { color:#b5a46f; font-size:11px; }.danger { background:#6c3028; }
.audit-list span { color:#aeb99b; font-family:var(--mc-font-mono); font-size:11px; }
.timeline { margin:0; padding:16px; list-style:none; }.timeline li { display:grid; grid-template-columns:34px 1fr; gap:10px; padding-bottom:14px; }.timeline i { display:grid; place-items:center; width:28px; height:28px; background:#3d6127; border:2px solid #0c0e08; font-style:normal; }.timeline li>div { padding:10px; background:#12150e; border:2px solid #0c0e08; }.timeline small { display:block; color:#7f8774; }.timeline pre { max-height:180px; overflow:auto; color:#aeb99b; white-space:pre-wrap; }
.agenda-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; }.agenda-card { padding:15px; background:#1b1e14; border:2px solid #0c0e08; }.agenda-card>div { display:flex; flex-direction:column; gap:5px; }.agenda-card>div span { color:#d3b55d; text-transform:uppercase; }.agenda-card dl div { display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid #343a2b; }.agenda-card dd { margin:0; color:#d8ddcd; }.agenda-card small { color:#8f9682; }
.agenda-card .validation-progress { display:grid; grid-template-columns:repeat(3,1fr); gap:7px; margin-top:12px; padding:10px; background:#12150e; border:2px solid #303727; }.validation-progress strong,.validation-progress small { grid-column:1/-1; }.validation-progress span { color:#b7c4a6 !important; text-transform:none !important; font-family:var(--mc-font-mono); font-size:11px; }
@media (max-width:1000px) { .kpi-grid { grid-template-columns:repeat(2,1fr); } .workspace,.analysis-layout { grid-template-columns:1fr; } .candidate-source-grid { grid-template-columns:1fr; } .inspector { min-height:220px; } }
@media (max-width:700px) { .evolution-header,.task-context,.experiment-gate { flex-direction:column; align-items:stretch; } .gate-facts { justify-content:flex-start; } .task-context select { min-width:0; max-width:none; width:100%; } .toolbar { flex-wrap:wrap; } .result-count { width:100%; margin-left:0; } .kpi-grid,.view-tabs { grid-template-columns:1fr 1fr; } .curve-grid { grid-template-columns:1fr; } .lineage-validation { grid-template-columns:1fr; } }
</style>
