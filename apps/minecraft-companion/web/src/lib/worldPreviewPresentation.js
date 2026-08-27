export const WORLD_PREVIEW_MODES = Object.freeze(['radar', 'simple', 'authentic']);

const VALID_PREVIEW_MODES = new Set(WORLD_PREVIEW_MODES);
const VALID_WORLD_MODES = new Set(['simple', 'authentic']);

export function normalizeWorldPreviewMode(value) {
  return VALID_PREVIEW_MODES.has(value) ? value : 'radar';
}

export function migrateWorldPreviewModes({
  storedModes,
  profileIds,
  legacyShow3D,
  legacyWorldModes,
} = {}) {
  const source = storedModes && !Array.isArray(storedModes) && typeof storedModes === 'object'
    ? storedModes
    : {};
  const migrated = Object.fromEntries(
    Object.entries(source).filter(([, value]) => VALID_PREVIEW_MODES.has(value)),
  );
  let changed = Object.keys(migrated).length !== Object.keys(source).length;
  const migratingLegacyStore = Object.keys(migrated).length === 0;
  const legacy3DEnabled = legacyShow3D === '1' || legacyShow3D === true;

  for (const profileId of profileIds || []) {
    if (!profileId || migrated[profileId]) continue;
    const legacyWorldMode = VALID_WORLD_MODES.has(legacyWorldModes?.[profileId])
      ? legacyWorldModes[profileId]
      : 'simple';
    migrated[profileId] = migratingLegacyStore && legacy3DEnabled ? legacyWorldMode : 'radar';
    changed = true;
  }

  return { modes: migrated, changed };
}

function previewModeLabel(mode) {
  if (mode === 'authentic') return '真实世界';
  if (mode === 'simple') return '简略 3D';
  return '轻量雷达';
}

export function projectWorldPreview({
  mode,
  hasProfile = false,
  hubConnected = false,
  brainReady = false,
  inGame = false,
  connectionStatus = '',
  lastError = '',
  hasWorldState = false,
  pendingAction = '',
} = {}) {
  const normalizedMode = normalizeWorldPreviewMode(mode);
  const connected = Boolean(inGame || connectionStatus === 'connected');
  const pending = pendingAction === 'connect' || pendingAction === 'disconnect';
  const shouldMountScene = connected && hasWorldState && normalizedMode !== 'radar';
  const base = {
    mode: normalizedMode,
    modeLabel: previewModeLabel(normalizedMode),
    connected,
    shouldMountScene,
    canAct: Boolean(hasProfile && hubConnected && !pending),
    action: connected ? 'disconnect' : 'connect',
    actionLabel: connected ? '断开 Minecraft 世界' : '连接 Minecraft 世界',
    stage: 'world-disconnected',
    tone: 'idle',
    kicker: 'WORLD PREVIEW',
    title: `${previewModeLabel(normalizedMode)}已就绪`,
    message: '由伙伴连接 Minecraft 服务器；浏览者无需启动 Minecraft 客户端。',
  };

  if (!hasProfile) {
    return {
      ...base,
      stage: 'no-profile',
      canAct: false,
      title: '先选择一个伙伴',
      message: '选择伙伴后即可配置并连接 Minecraft 世界。',
    };
  }

  if (!hubConnected) {
    return {
      ...base,
      stage: 'hub-disconnected',
      canAct: false,
      tone: 'error',
      kicker: 'HUB OFFLINE',
      title: 'Hub 已断开',
      message: '恢复 Hub 连接后才能让伙伴读取 Minecraft 世界。',
    };
  }

  if (pendingAction === 'disconnect') {
    return {
      ...base,
      stage: 'disconnecting',
      canAct: false,
      action: 'disconnect',
      actionLabel: '正在断开…',
      tone: 'warning',
      kicker: 'DISCONNECTING',
      title: '正在断开 Minecraft 世界',
      message: '伙伴会保留日常陪聊能力，世界预览将在断开后释放。',
    };
  }

  if (pendingAction === 'connect') {
    return {
      ...base,
      stage: 'connecting',
      canAct: false,
      action: 'connect',
      actionLabel: '正在连接…',
      tone: 'warning',
      kicker: 'CONNECTING',
      title: '正在连接 Minecraft 世界',
      message: `${previewModeLabel(normalizedMode)}已选择，连接成功后会自动进入预览。`,
    };
  }

  if (connected && !hasWorldState) {
    return {
      ...base,
      stage: 'waiting-world-state',
      tone: 'warning',
      kicker: 'READING WORLD',
      title: '正在读取世界首帧',
      message: `${previewModeLabel(normalizedMode)}已选择，收到真实世界数据后会自动显示。`,
    };
  }

  if (connected) {
    const message = normalizedMode === 'radar'
      ? '世界已连接，当前保持低负载雷达；选择简略或真实即可打开 3D。'
      : normalizedMode === 'authentic'
        ? '正在显示真实世界预览，可在场景内管理资源包与缺失素材。'
        : '正在显示来自当前 Minecraft 世界的简略 3D 预览。';
    return {
      ...base,
      stage: 'ready',
      tone: 'ready',
      kicker: 'WORLD READY',
      title: `${previewModeLabel(normalizedMode)}运行中`,
      message,
    };
  }

  if (lastError) {
    return {
      ...base,
      stage: 'error',
      tone: 'error',
      kicker: 'CONNECTION ERROR',
      title: 'Minecraft 世界连接失败',
      message: String(lastError),
      actionLabel: '重试连接',
    };
  }

  if (!brainReady) {
    return {
      ...base,
      stage: 'companion-offline',
      title: '伙伴尚未启动',
      message: `连接世界时会先启动伙伴；${previewModeLabel(normalizedMode)}选择会保留。`,
    };
  }

  return base;
}
