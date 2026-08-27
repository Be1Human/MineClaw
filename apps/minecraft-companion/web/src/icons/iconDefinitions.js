const VIEW_BOX = '0 0 16 16';

function defineIcon(...layers) {
  return Object.freeze({
    viewBox: VIEW_BOX,
    layers: Object.freeze(layers.map(layer => Object.freeze({
      d: layer.d,
      tone: layer.tone ?? 'primary',
      fillRule: layer.fillRule,
    }))),
  });
}

function primary(d, options = {}) {
  return { d, ...options };
}

function accent(d, options = {}) {
  return { d, tone: 'accent', ...options };
}

const originalDefinitions = {
  unknown: defineIcon(
    primary('M2 1h12v2h2v10h-2v2H2v-2H0V3h2V1Zm2 3v2h2V4H4Zm6 0v2h2V4h-2ZM6 7v2h4V7H6Zm-2 4v2h8v-2H4Z'),
  ),
  settings: defineIcon(
    primary('M6 0h4v2h2v2h2v2h2v4h-2v2h-2v2h-2v2H6v-2H4v-2H2v-2H0V6h2V4h2V2h2V0Zm0 5H5v6h6V5H6Zm1 2h2v2H7V7Z', { fillRule: 'evenodd' }),
  ),
  close: defineIcon(
    primary('M2 2h3v2h2v2h2V4h2V2h3v3h-2v2h-2v2h2v2h2v3h-3v-2H9v-2H7v2H5v2H2v-3h2V9h2V7H4V5H2V2Z'),
  ),
  plus: defineIcon(
    primary('M7 1h2v6h6v2H9v6H7V9H1V7h6V1Z'),
  ),
  minus: defineIcon(
    primary('M2 7h12v2H2V7Z'),
  ),
  maximize: defineIcon(
    primary('M2 2h12v12H2V2Zm2 2v8h8V4H4Z', { fillRule: 'evenodd' }),
  ),
  chat: defineIcon(
    primary('M2 1h12v2h2v8h-2v2H8l-4 3v-3H2v-2H0V3h2V1Zm2 3H2v7h4v2l2-2h6V3H4v1Zm1 2h2v2H5V6Zm4 0h2v2H9V6Z', { fillRule: 'evenodd' }),
  ),
  more: defineIcon(
    primary('M7 1h2v3H7V1Zm0 5h2v4H7V6Zm0 6h2v3H7v-3Z'),
  ),
  'chevron-down': defineIcon(
    primary('M2 5h3v2h2v2h2V7h2V5h3v3h-2v2h-2v2H6v-2H4V8H2V5Z'),
  ),
  collapse: defineIcon(
    primary('M1 1h2v14H1V1Zm7 2h3v2h-2v2h6v2H9v2h2v2H8L3 8l5-5Z'),
  ),
  focus: defineIcon(
    primary('M1 1h6v2H3v4H1V1Zm8 0h6v6h-2V3H9V1ZM1 9h2v4h4v2H1V9Zm12 0h2v6H9v-2h4V9Z'),
  ),
  send: defineIcon(
    primary('M0 1l16 7-16 7V9l10-1L0 7V1Zm3 3v2l7 2-7 2v2l9-4-9-4Z', { fillRule: 'evenodd' }),
  ),
  undo: defineIcon(
    primary('M5 0h2v3h5v2h2v2h2v7h-3V8h-2V6H7v4H5L0 5l5-5Z'),
  ),
  play: defineIcon(
    primary('M2 1h3v2h3v2h3v2h3v2h-3v2H8v2H5v2H2V1Z'),
  ),
  stop: defineIcon(
    primary('M2 2h12v12H2V2Zm3 3v6h6V5H5Z', { fillRule: 'evenodd' }),
  ),
  compass: defineIcon(
    primary('M7 0h2v3h2v2h2v2h3v2h-3v2h-2v2H9v3H7v-3H5v-2H3V9H0V7h3V5h2V3h2V0Zm0 5v2H5v2h2v2h2V9h2V7H9V5H7Z', { fillRule: 'evenodd' }),
  ),
  health: defineIcon(
    primary('M2 2h4v2h4V2h4v2h2v6h-2v2h-2v2h-2v2H6v-2H4v-2H2v-2H0V4h2V2Z'),
    accent('M3 5h3v2h4V5h3v5h-2v2H9v2H7v-2H5v-2H3V5Z'),
  ),
  thinking: defineIcon(
    primary('M3 1h8v1h2v2h2v6h-2v2H9v2H6v2H3v-4H1V4h2V1Zm2 4H3v2h2V5Zm4 0H7v2h2V5Zm4 0h-2v2h2V5Z', { fillRule: 'evenodd' }),
  ),
  brain: defineIcon(
    primary('M4 1h3v2h2V1h3v2h2v3h2v5h-2v3h-3v2H8v-3H7v3H4v-2H2v-3H0V6h2V3h2V1Zm1 4H3v2h2v3H3v2h3V4H5v1Zm8 0h-2V4H9v8h3v-2h-2V7h3V5Z', { fillRule: 'evenodd' }),
  ),
  tool: defineIcon(
    primary('M1 1h4v2h2v3h2l5 5v4h-4l-5-5H3V8H1V6H0V2h1V1Zm2 2H2v2h2V4H3V3Zm9 9h-2v2h2v-2Z', { fillRule: 'evenodd' }),
  ),
  success: defineIcon(
    primary('M13 2h3v4h-2v2h-2v2h-2v2H8v2H5v-2H3v-2H1V6h4v2h2v1h1V8h2V6h2V4h1V2Z'),
  ),
  error: defineIcon(
    primary('M3 1h10v2h2v10h-2v2H3v-2H1V3h2V1Zm2 3v2h2v2H5v2h2V8h2v2h2V8H9V6h2V4H9v2H7V4H5Z', { fillRule: 'evenodd' }),
  ),
  finish: defineIcon(
    primary('M2 0h2v16H2V0Zm3 2h9v2h2v7H9V9H5V2Zm2 2v3h4v2h3V4H7Z', { fillRule: 'evenodd' }),
  ),
  gather: defineIcon(
    primary('M9 0h5v2h2v3h-2V3h-3v2H9v2H7v2H5v7H2v-6H0V7h5V5h2V3h2V0Z'),
  ),
  craft: defineIcon(
    primary('M2 1h7v2h3v2h2v3h-4V6H8v9H4V6H2v2H0V3h2V1Z'),
  ),
  task: defineIcon(
    primary('M5 0h6v2h3v14H2V2h3V0Zm2 2v2h2V2H7ZM4 5v9h8V5H4Zm2 2h4v2H6V7Zm0 4h4v2H6v-2Z', { fillRule: 'evenodd' }),
  ),
  door: defineIcon(
    primary('M3 0h10v16H3V0Zm2 2v12h6V2H5Zm3 6h2v2H8V8Z', { fillRule: 'evenodd' }),
  ),
  stuck: defineIcon(
    primary('M0 0h3v2h2v2h2v2h2V4h2V2h2V0h3v3h-2v2h-2v2h4v2h-4v2h2v2h2v3h-3v-2h-2v-2H9v4H7v-4H5v2H3v2H0v-3h2v-2h2V9H0V7h4V5H2V3H0V0Zm7 7v2h2V7H7Z'),
  ),
  critic: defineIcon(
    primary('M7 0h2v2h5v2h-1l3 5h-2v2H9V9h2l-2-4v9h3v2H4v-2h3V5L5 9h2v2H2V9H0l3-5H2V2h5V0Zm-4 9h2L4 6 3 9Zm8 0h2l-1-3-1 3Z', { fillRule: 'evenodd' }),
  ),
  memory: defineIcon(
    primary('M1 0h12l2 2v14H1V0Zm2 2v5h9V2h-2v3H8V2H3Zm0 7v5h10V9H3Zm2 1h6v3H5v-3Z', { fillRule: 'evenodd' }),
  ),
  skill: defineIcon(
    primary('M2 1h9v2h2v10h-2v2H2V1Zm2 2v10h7V3H4Z', { fillRule: 'evenodd' }),
    accent('M13 0h2v2h1v2h-1v2h-2V4h-2V2h2V0Zm-6 5h2v2h2v2H9v2H7V9H5V7h2V5Z'),
  ),
  activity: defineIcon(
    primary('M0 7h3l2-5h2l2 10 2-5h5v2h-3l-3 7H8L6 6 5 9H0V7Z'),
  ),
  history: defineIcon(
    primary('M2 0h10v2h2v12h-2v2H2v-2H0V2h2V0Zm2 2v12h6v-2h2V2H4Zm2 2h4v2H6V4Zm0 4h4v2H6V8Z', { fillRule: 'evenodd' }),
  ),
  backpack: defineIcon(
    primary('M5 0h6v2h2v2h2v11H1V4h2V2h2V0Zm1 2v2h4V2H6ZM3 6v2h10V6H3Zm2 4v3h6v-3H5Z', { fillRule: 'evenodd' }),
  ),
  route: defineIcon(
    primary('M1 1h5v5H1V1Zm2 2v1h1V3H3Zm8-2h4v4h-4V1Zm2 2h1V2h-1v1ZM3 8h2v2h6V7h2v5H5v2h3v2H3V8Zm9 6h3v2h-3v-2Z', { fillRule: 'evenodd' }),
  ),
  pen: defineIcon(
    primary('M11 0h3v2h2v3L6 15H0V9L10 0h1Zm1 3L3 12v1h2l9-9-2-1Z', { fillRule: 'evenodd' }),
  ),
  fill: defineIcon(
    primary('M5 0h4v2h2v2h2v2h2v4h-2v2H3v-2H1V6h2V4h2V0Zm1 3L3 7l4 4h5v-1h1V7L8 2 6 3Zm9 9h1v4h-4v-1h1v-2h2v-1Z', { fillRule: 'evenodd' }),
  ),
  eyedropper: defineIcon(
    primary('M11 0h3v2h2v3l-3 3-2-2-5 5v2H4v2H0v-4h2V9h2l5-5-2-2 2-2h2Zm0 2-1 1 3 3 1-1-3-3ZM3 11v2H2v1h1v-1h2v-2H3Z', { fillRule: 'evenodd' }),
  ),
  erase: defineIcon(
    primary('M6 1h4l6 6v3l-5 5H5l-5-5V7l6-6Zm1 2L2 8v1l4 4h4l4-4V8L9 3H7Zm-3 7 3-3 4 4-2 2H6l-2-3Z', { fillRule: 'evenodd' }),
  ),
  bot: defineIcon(
    primary('M7 0h2v2h4v2h2v10h-2v2H3v-2H1V4h2V2h4V0ZM3 5v7h10V5H3Zm2 2h2v2H5V7Zm4 0h2v2H9V7ZM5 10h6v1H5v-1Z', { fillRule: 'evenodd' }),
  ),
  refresh: defineIcon(
    primary('M4 1h7v2h2v2h2V1h1v7H9V6h4V5h-2V3H4v2H2V3h2V1Zm3 7v2H3v1h2v2h7v-2h2v2h-2v2H5v-2H3v-2H1v4H0V8h7Z'),
  ),
  trash: defineIcon(
    primary('M5 0h6v2h4v2H1V2h4V0ZM3 5h10v11H3V5Zm2 2v7h2V7H5Zm4 0v7h2V7H9Z', { fillRule: 'evenodd' }),
  ),
  package: defineIcon(
    primary('M3 1h10l3 3v9l-3 3H3l-3-3V4l3-3Zm1 2L2 5v7l2 2h8l2-2V5l-2-2H4Zm0 3h8v2H9v4H7V8H4V6Z', { fillRule: 'evenodd' }),
  ),
  key: defineIcon(
    primary('M2 1h6l3 3v2h5v4h-2v2h-2v2H9v-3H7l-2 2H2l-2-2V4l2-3Zm1 2L2 5v5l1 1h1l2-2h5v2h1V9h2V8H9V5L7 3H3Zm1 2h2v2H4V5Z', { fillRule: 'evenodd' }),
  ),
  warning: defineIcon(
    primary('M6 0h4v2h2v4h2v4h2v5H0v-5h2V6h2V2h2V0Zm1 4v6h2V4H7Zm0 8v2h2v-2H7Z', { fillRule: 'evenodd' }),
  ),
  'id-card': defineIcon(
    primary('M1 2h14v12H1V2Zm2 2v8h10V4H3Zm1 1h3v3H4V5Zm5 0h3v2H9V5Zm0 4h3v2H9V9ZM4 9h3v2H4V9Z', { fillRule: 'evenodd' }),
  ),
  server: defineIcon(
    primary('M1 1h14v4H1V1Zm2 2v1h2V3H3Zm4 0v1h6V3H7ZM1 6h14v4H1V6Zm2 2v1h2V8H3Zm4 0v1h6V8H7ZM1 11h14v4H1v-4Zm2 2v1h2v-1H3Zm4 0v1h6v-1H7Z', { fillRule: 'evenodd' }),
  ),
  character: defineIcon(
    primary('M5 0h6v2h2v5h-2v2h2v2h2v5H1v-5h2V9h2V7H3V2h2V0Zm0 2v4h6V2H5Zm2 6v3H5v3h6v-3H9V8H7Z', { fillRule: 'evenodd' }),
  ),
  world: defineIcon(
    primary('M4 0h8v2h2v2h2v8h-2v2h-2v2H4v-2H2v-2H0V4h2V2h2V0Zm1 2v3H2v3h4v6h4v-3h4V7h-3V4H8V2H5Zm5 5H8v2h2V7Z', { fillRule: 'evenodd' }),
  ),
  day: defineIcon(
    primary('M7 0h2v3H7V0ZM2 1h2v2H2V1Zm10 0h2v2h-2V1ZM5 4h6v2h2v6h-2v2H5v-2H3V6h2V4Zm1 2H5v6h6V6H6ZM0 7h3v2H0V7Zm13 0h3v2h-3V7ZM2 13h2v2H2v-2Zm10 0h2v2h-2v-2ZM7 13h2v3H7v-3Z', { fillRule: 'evenodd' }),
  ),
  night: defineIcon(
    primary('M5 0h5v2h2v2h2v7h-2v2h-2v2H5v-2H3v-2H1V5h2V2h2V0Zm0 3H3v7h2v2h5v-2H8V8H6V5H5V3Z', { fillRule: 'evenodd' }),
  ),
  shield: defineIcon(
    primary('M2 1h12v10h-2v2h-2v2H6v-2H4v-2H2V1Zm2 2v7h2v2h4v-2h2V3H4Z', { fillRule: 'evenodd' }),
  ),
  blocked: defineIcon(
    primary('M4 0h8v2h2v2h2v8h-2v2h-2v2H4v-2H2v-2H0V4h2V2h2V0Zm1 2H4v1l9 9h1v-1L5 2ZM2 5v6h2v2h6L3 4H2v1Zm4-3 8 8V5h-2V3h-2V2H6Z', { fillRule: 'evenodd' }),
  ),
  disabled: defineIcon(
    primary('M7 0h2v8H7V0ZM3 2h2v2H3v2H1v5h2v2h2v2h6v-2h2v-2h2V6h-2V4h-2V2h2v2h2v2h1v5h-1v2h-2v2h-2v1H5v-1H3v-2H1v-2H0V6h1V4h2V2Z'),
  ),
  eye: defineIcon(
    primary('M4 2h8v2h2v2h2v4h-2v2h-2v2H4v-2H2v-2H0V6h2V4h2V2Zm1 2v2H3v4h2v2h6v-2h2V6h-2V4H5Zm2 2h2v1h1v2H9v1H7V9H6V7h1V6Z', { fillRule: 'evenodd' }),
  ),
  food: defineIcon(
    primary('M2 0h6v2h2v2h2v4h-2v2H8v2H6v4H2v-2H0v-4h2V8H0V4h2V0Zm2 2v6h4v2H6v2H4v2H2v-2h2V9H2V4h2V2Zm9 8h3v4h-1v2h-4v-3h2v-3Z', { fillRule: 'evenodd' }),
  ),
  goal: defineIcon(
    primary('M5 0h6v2h2v2h2v2h1v4h-1v2h-2v2h-2v2H5v-2H3v-2H1v-2H0V6h1V4h2V2h2V0Zm0 3H4v2H2v6h2v2h8v-2h2V7h-4V3H5Zm1 3h5v2h-1v2H8v2H6V6Z', { fillRule: 'evenodd' }),
  ),
  'external-link': defineIcon(
    primary('M8 1h7v7h-2V5L7 11 5 9l6-6H8V1ZM1 3h6v2H3v8h8V9h2v6H1V3Z'),
  ),
  lightning: defineIcon(
    primary('M8 0h5l-3 6h5v2L7 16H4l2-6H1V8L8 0Z'),
  ),
  'status-dot': defineIcon(
    primary('M4 1h8v2h2v2h2v6h-2v2h-2v2H4v-2H2v-2H0V5h2V3h2V1Zm1 3H4v8h8V4H5Z', { fillRule: 'evenodd' }),
  ),
};

export const iconAliases = Object.freeze({
  connected: 'success',
  disconnected: 'error',
});

const definitions = {
  ...originalDefinitions,
  ...Object.fromEntries(
    Object.entries(iconAliases).map(([name, target]) => [name, originalDefinitions[target]]),
  ),
};

export const iconDefinitions = Object.freeze(definitions);
export const iconNames = Object.freeze(Object.keys(iconDefinitions));

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(iconDefinitions, name);
}

export function resolveIcon(name) {
  return hasIcon(name) ? iconDefinitions[name] : iconDefinitions.unknown;
}
