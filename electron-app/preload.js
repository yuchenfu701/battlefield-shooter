const { contextBridge, ipcRenderer } = require('electron');

// 安全地将 Electron API 暴露给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
    // 窗口控制
    minimize:       () => ipcRenderer.invoke('window-minimize'),
    maximize:       () => ipcRenderer.invoke('window-maximize'),
    close:          () => ipcRenderer.invoke('window-close'),

    // 多人游戏
    openMultiplayer:() => ipcRenderer.invoke('open-multiplayer'),

    // 系统信息
    getVersion:     () => ipcRenderer.invoke('get-app-version'),
    getPlatform:    () => ipcRenderer.invoke('get-platform'),

    // 监听主进程事件
    on: (channel, callback) => {
        const validChannels = ['game-event', 'server-status'];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => callback(...args));
        }
    },
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    }
});
