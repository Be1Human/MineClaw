// Preload script — context isolation bridge
// 前端主要通过 Socket.IO + REST 与后端通信；这里仅暴露无边框窗口控制（自定义标题栏用）。
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  setDesktopPetMousePassthrough: (passthrough) => ipcRenderer.send('desktop-pet:set-mouse-passthrough', passthrough === true),
  beginDesktopPetDrag: (pointer) => ipcRenderer.send('desktop-pet:drag-begin', pointer),
  updateDesktopPetDrag: (pointer) => ipcRenderer.send('desktop-pet:drag-update', pointer),
  endDesktopPetDrag: () => ipcRenderer.send('desktop-pet:drag-end'),
  onDesktopPetState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop-pet:state', listener);
    return () => ipcRenderer.removeListener('desktop-pet:state', listener);
  },
})
