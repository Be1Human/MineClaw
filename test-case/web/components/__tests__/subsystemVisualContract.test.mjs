import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (relativePath) => readFileSync(
  new URL(`../../../../apps/minecraft-companion/web/src/${relativePath}`, import.meta.url),
  'utf8',
);

const themeSource = source('theme-mc.css');
const appSource = source('App.vue');
const componentSources = {
  brain: source('components/BrainPanel.vue'),
  memory: source('components/MemoryPanel.vue'),
  trace: source('components/LlmTracePanel.vue'),
  settings: source('components/SettingsPanel.vue'),
  tasks: source('components/TaskBarPanel.vue'),
  inventory: source('components/InventoryPanel.vue'),
  skin: source('components/SkinEditor.vue'),
};

test('子系统共用正式版页面、面板、字段、空态与弹窗原语', () => {
  for (const selector of [
    '.mc-subsystem',
    '.mc-subsystem-header',
    '.mc-subnav',
    '.mc-panel',
    '.mc-toolbar',
    '.mc-button',
    '.mc-field-control',
    '.mc-empty-state',
    '.mc-dialog-backdrop',
    '.mc-dialog-header',
    '.mc-dialog-footer',
  ]) {
    assert.ok(themeSource.includes(selector), `缺少共享视觉原语 ${selector}`);
  }
  assert.match(themeSource, /--mc-radius-sm:/);
  assert.match(themeSource, /--mc-space-4:/);
});

test('大脑、记忆、轨迹与设置使用同一套子系统层级', () => {
  assert.match(componentSources.brain, /class="brain-view mc-subsystem"/);
  assert.match(componentSources.brain, /class="brain-header mc-subsystem-header"/);
  assert.match(componentSources.memory, /class="memory-header mc-panel"/);
  assert.match(componentSources.memory, /mc-empty-state/);
  assert.match(componentSources.trace, /class="trace-panel mc-subsystem"/);
  assert.match(componentSources.trace, /class="trace-header mc-subsystem-header"/);
  assert.match(componentSources.settings, /class="settings-view mc-subsystem"/);
  assert.match(componentSources.settings, /class="settings-content mc-page"/);
});

test('右侧任务、背包与日志面板共享正式版容器和结构化空态', () => {
  assert.match(componentSources.tasks, /class="taskbar-panel mc-panel"/);
  assert.match(componentSources.tasks, /class="taskbar-body taskbar-state taskbar-state--empty"/);
  assert.match(componentSources.inventory, /class="inv-panel mc-panel"/);
  assert.match(componentSources.inventory, /class="inv-empty mc-empty-state"/);
  assert.match(appSource, /class="inspector-logs mc-panel"/);
  assert.match(appSource, /class="inspector-logs-empty mc-empty-state"/);

  // 背包格子属于 Minecraft 数据可视化，允许保留局部像素语义。
  assert.match(componentSources.inventory, /\.inv-slot/);
});

test('新建伙伴与皮肤编辑器使用可访问的共享弹窗外壳', () => {
  assert.equal((appSource.match(/class="mc-dialog-backdrop"/g) || []).length, 2);
  assert.equal((appSource.match(/role="dialog"/g) || []).length, 2);
  assert.equal((appSource.match(/aria-modal="true"/g) || []).length, 2);
  assert.match(appSource, /ref="createDialog" class="mc-dialog create-partner-dialog"/);
  assert.match(appSource, /ref="skinDialog" class="mc-dialog wide"/);
  assert.match(appSource, /@keydown\.esc="showCreateForm = false"/);
  assert.match(appSource, /@keydown\.esc="showSkinEditor = false"/);
  assert.doesNotMatch(appSource, /NEW PARTNER|inputStyle/);
});

test('皮肤编辑器移除按钮样式字符串并保留调色板动态色值', () => {
  assert.match(componentSources.skin, /class="skin-editor"/);
  assert.match(componentSources.skin, /class="skin-preview mc-panel"/);
  assert.doesNotMatch(
    componentSources.skin,
    /toolBtnStyle|fileBtnStyle|linkBtnStyle|modelBtnStyle|saveBtnStyle/,
  );
  assert.match(componentSources.skin, /:style="\{ background: c \}"/);
});

test('迁移后的组件没有通过 important 覆盖外层主题', () => {
  for (const [name, contents] of Object.entries(componentSources)) {
    assert.doesNotMatch(contents, /!important/, `${name} 不应使用 !important`);
  }
});
