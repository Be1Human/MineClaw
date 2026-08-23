function base(botId) {
  return `/api/bots/${encodeURIComponent(botId)}/planner-evolution`;
}

export async function fetchEvolutionSummary(botId) {
  return request(`${base(botId)}/summary`);
}

export async function fetchEvolutionGraph(botId, options = {}) {
  const params = new URLSearchParams();
  if (options.root) params.set('root', options.root);
  if (options.type) params.set('type', options.type);
  if (options.search) params.set('search', options.search);
  if (options.depth != null) params.set('depth', String(options.depth));
  if (options.maxNodes != null) params.set('maxNodes', String(options.maxNodes));
  if (options.maxEdges != null) params.set('maxEdges', String(options.maxEdges));
  const query = params.size ? `?${params}` : '';
  return request(`${base(botId)}/graph${query}`);
}

export async function fetchEvolutionDashboard(botId) {
  return request(`${base(botId)}/dashboard`);
}

export async function downloadEvolutionAudit(botId, scope = 'full', id = '') {
  const params = new URLSearchParams({ scope });
  if (id) params.set('id', id);
  const response = await fetch(`${base(botId)}/export?${params}`);
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const fileName = disposition.match(/filename="([^"]+)"/)?.[1] || 'planner-experience.zip';
  const url = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
}

export async function disableEvolutionPolicy(botId, policyId, expectedRevision, reason) {
  return request(`${base(botId)}/policies/${encodeURIComponent(policyId)}/disable`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision, reason }),
  });
}

export async function rollbackEvolutionPolicy(botId, policyId, expectedRevision, reason) {
  return request(`${base(botId)}/policies/${encodeURIComponent(policyId)}/rollback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision, reason }),
  });
}

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}
