export function desktopPetEnvironmentCopy(isElectron) {
  if (isElectron) {
    return {
      saveLabel: '保存并立即应用',
      successMessage: '桌面角色设置已应用',
      notice: '',
    };
  }
  return {
    saveLabel: '仅保存配置',
    successMessage: '设置已保存；请在 MineClaw 桌面版中启用此 Beta 功能',
    notice: '当前是浏览器界面，只能保存配置，不能创建原生桌面角色。请启动 MineClaw 桌面版后再启用此 Beta 功能。',
  };
}
