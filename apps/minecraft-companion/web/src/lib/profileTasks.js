import { ref } from 'vue';

export function useProfileTasks(fetchImpl = (...args) => fetch(...args)) {
  const tasks = ref([]);
  const state = ref('ready');
  const error = ref('');
  let activeBotId = null;
  let requestId = 0;

  async function request(showLoading = false) {
    const botId = activeBotId;
    if (!botId) return false;

    const currentRequestId = ++requestId;
    if (showLoading) state.value = 'loading';
    error.value = '';

    try {
      const response = await fetchImpl(`/api/bots/${encodeURIComponent(botId)}/v2/tasks`);
      let body = {};
      try { body = await response.json(); } catch { /* handled by the HTTP error below */ }

      if (currentRequestId !== requestId || botId !== activeBotId) return false;
      if (!response.ok) throw new Error(body.error || `任务读取失败 (${response.status})`);
      if (body.botId !== botId) throw new Error('任务响应与当前伙伴不一致');

      tasks.value = Array.isArray(body.tasks) ? body.tasks : [];
      state.value = 'ready';
      return true;
    } catch (cause) {
      if (currentRequestId !== requestId || botId !== activeBotId) return false;
      tasks.value = [];
      error.value = cause instanceof Error ? cause.message : String(cause);
      state.value = 'error';
      return false;
    }
  }

  function selectBot(botId) {
    activeBotId = botId || null;
    requestId += 1;
    tasks.value = [];
    error.value = '';
    state.value = activeBotId ? 'loading' : 'ready';
    return activeBotId ? request(false) : Promise.resolve(false);
  }

  function refresh({ showLoading = false } = {}) {
    return request(showLoading);
  }

  return { tasks, state, error, selectBot, refresh };
}
