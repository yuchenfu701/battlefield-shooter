const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');

// ─── 单实例锁 ─────────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

let mainWindow = null;
let gameWindow = null;

// ─── 主窗口 ──────────────────────────────────────────────────────────────────
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width:  1440,
        height: 900,
        minWidth:  1024,
        minHeight: 680,
        title: '战地射击 - 桌面版',
        backgroundColor: '#0a0c0a',
        show: false,
        frame: false,               // 自定义标题栏
        titleBarStyle: 'hidden',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,     // 允许 file:// 下 fetch 本地资源
            allowRunningInsecureContent: true,
        }
    });

    // 游戏主文件路径
    const gameFile = path.join(__dirname, '..', 'index.html');
    if (fs.existsSync(gameFile)) {
        mainWindow.loadFile(gameFile);
    } else {
        // 打包后路径
        const packedPath = path.join(process.resourcesPath, 'game', 'index.html');
        mainWindow.loadFile(packedPath);
    }

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        // 开发模式下打开 DevTools
        if (process.env.NODE_ENV === 'development') {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (gameWindow) { gameWindow.close(); gameWindow = null; }
        app.quit();
    });

    // 外链在系统浏览器中打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    buildMenu();
}

// ─── 联机大厅窗口（多人游戏） ────────────────────────────────────────────────
function createGameWindow() {
    if (gameWindow) { gameWindow.focus(); return; }

    gameWindow = new BrowserWindow({
        width:  1440,
        height: 900,
        title: '战地射击 - 联机大厅',
        backgroundColor: '#060a0f',
        show: false,
        parent: mainWindow,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
        }
    });

    const lobbyFile = path.join(__dirname, '..', 'multiplayer', 'index.html');
    if (fs.existsSync(lobbyFile)) {
        gameWindow.loadFile(lobbyFile);
    }

    gameWindow.once('ready-to-show', () => gameWindow.show());
    gameWindow.on('closed', () => { gameWindow = null; });
}

// ─── 应用菜单 ────────────────────────────────────────────────────────────────
function buildMenu() {
    const template = [
        {
            label: '游戏',
            submenu: [
                {
                    label: '单机模式',
                    accelerator: 'CmdOrCtrl+1',
                    click: () => mainWindow && mainWindow.focus()
                },
                {
                    label: '联机大厅',
                    accelerator: 'CmdOrCtrl+2',
                    click: createGameWindow
                },
                { type: 'separator' },
                {
                    label: '全屏',
                    accelerator: 'F11',
                    click: () => {
                        if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
                    }
                },
                { type: 'separator' },
                {
                    label: '退出游戏',
                    accelerator: 'CmdOrCtrl+Q',
                    click: () => app.quit()
                }
            ]
        },
        {
            label: '视图',
            submenu: [
                {
                    label: '重新载入',
                    accelerator: 'CmdOrCtrl+R',
                    click: () => { if (mainWindow) mainWindow.reload(); }
                },
                {
                    label: '强制重新载入',
                    accelerator: 'CmdOrCtrl+Shift+R',
                    click: () => { if (mainWindow) mainWindow.webContents.reloadIgnoringCache(); }
                },
                { type: 'separator' },
                {
                    label: '开发者工具',
                    accelerator: 'F12',
                    click: () => { if (mainWindow) mainWindow.webContents.toggleDevTools(); }
                }
            ]
        },
        {
            label: '窗口',
            submenu: [
                {
                    label: '最小化',
                    accelerator: 'CmdOrCtrl+M',
                    role: 'minimize'
                },
                {
                    label: '关闭窗口',
                    accelerator: 'CmdOrCtrl+W',
                    role: 'close'
                }
            ]
        },
        {
            label: '帮助',
            submenu: [
                {
                    label: '游戏说明',
                    click: () => {
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: '操作说明',
                            message: '战地射击 - 操控指南',
                            detail:
                                'WASD - 移动\n' +
                                '鼠标 - 瞄准\n' +
                                '左键 - 射击\n' +
                                '右键 - 瞄准镜\n' +
                                'R    - 换弹\n' +
                                'F    - 检视武器\n' +
                                'G    - 投掷手榴弹\n' +
                                'E    - 互动 / 使用技能\n' +
                                '1/2  - 切换武器\n' +
                                'Shift- 奔跑\n' +
                                'Ctrl - 蹲伏\n' +
                                'Space- 跳跃\n' +
                                'T    - 切换视角\n' +
                                'Tab  - 装备界面\n' +
                                'Esc  - 暂停'
                        });
                    }
                },
                { type: 'separator' },
                {
                    label: '关于游戏',
                    click: () => {
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: '关于',
                            message: '战地射击 v1.0.0',
                            detail: '基于 Three.js 构建的三维战术射击游戏。\n\n支持单机 AI 对战与多人联机模式。'
                        });
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// ─── IPC 通信 ────────────────────────────────────────────────────────────────
ipcMain.handle('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
});
ipcMain.handle('window-maximize', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
    }
});
ipcMain.handle('window-close', () => {
    if (mainWindow) mainWindow.close();
});
ipcMain.handle('open-multiplayer', () => {
    createGameWindow();
});
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-platform', () => process.platform);

// ─── 性能优化 ────────────────────────────────────────────────────────────────
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-hardware-overlays', 'single-fullscreen');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-frame-rate-limit');

// ─── 应用生命周期 ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
    createMainWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// 捕获未处理异常，防止崩溃
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    dialog.showErrorBox('程序错误', `发生了一个未预期的错误：\n${err.message}`);
});
