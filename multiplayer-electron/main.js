/**
 * 战地射击 · 多人联机桌面版
 * Electron 主进程
 *
 * 启动流程：
 *   1. app.whenReady() → 在主进程内嵌式启动 HTTP + Socket.IO 服务器
 *   2. 服务器就绪后创建 BrowserWindow，加载 multiplayer/index.html
 *   3. 玩家无需手动启动任何服务，双击 exe 即用
 */

'use strict';

const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const path   = require('path');
const http   = require('http');
const fs     = require('fs');

// ─── GPU 加速 ────────────────────────────────────────────────────────────────
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-frame-rate-limit');

// ─── 单实例锁 ────────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

let mainWindow = null;
const PORT = 3000;

// ─────────────────────────────────────────────────────────────────────────────
//  内嵌服务器启动（将 server.js 的逻辑直接 require 进来）
// ─────────────────────────────────────────────────────────────────────────────
function resolveServerPath() {
    // 开发环境
    const devPath = path.join(__dirname, '..', 'server', 'server.js');
    if (fs.existsSync(devPath)) return devPath;
    // 打包后（extraResources）
    const pkgPath = path.join(process.resourcesPath, 'server', 'server.js');
    if (fs.existsSync(pkgPath)) return pkgPath;
    return null;
}

function resolveClientPath() {
    const devPath = path.join(__dirname, '..', 'multiplayer', 'index.html');
    if (fs.existsSync(devPath)) return devPath;
    const pkgPath = path.join(process.resourcesPath, 'multiplayer', 'index.html');
    if (fs.existsSync(pkgPath)) return pkgPath;
    return null;
}

let serverStarted = false;

function startEmbeddedServer() {
    if (serverStarted) return Promise.resolve();
    return new Promise((resolve, reject) => {
        // 先检测端口是否已被占用（可能用户手动启了服务器）
        const test = http.request({ hostname: 'localhost', port: PORT, path: '/' }, () => {
            console.log('[服务器] 端口已被占用，跳过内嵌启动');
            serverStarted = true;
            resolve();
        });
        test.on('error', () => {
            // 端口空闲，启动内嵌服务器
            try {
                const serverPath = resolveServerPath();
                if (!serverPath) {
                    return reject(new Error('找不到服务器文件 server.js'));
                }
                // 修改 server.js 的 accounts.json 存储路径到用户数据目录
                process.env.ACCOUNTS_DIR = app.getPath('userData');
                require(serverPath);
                serverStarted = true;
                console.log(`[服务器] 内嵌启动成功，端口 ${PORT}`);
                // 给服务器 200ms 完成 listen
                setTimeout(resolve, 200);
            } catch (e) {
                reject(e);
            }
        });
        test.end();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  主窗口
// ─────────────────────────────────────────────────────────────────────────────
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width:           1440,
        height:          900,
        minWidth:        1100,
        minHeight:       700,
        title:           '战地射击 · 联机版',
        backgroundColor: '#060a0f',
        show:            false,
        webPreferences: {
            preload:                  path.join(__dirname, 'preload.js'),
            nodeIntegration:          false,
            contextIsolation:         true,
            webSecurity:              false,    // 允许 file:// 访问 CDN 脚本
            allowRunningInsecureContent: true,
        },
    });

    const clientPath = resolveClientPath();
    if (clientPath) {
        mainWindow.loadFile(clientPath);
    } else {
        // 降级：直接访问本地服务器
        mainWindow.loadURL(`http://localhost:${PORT}/multiplayer/`);
    }

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        if (process.env.NODE_ENV === 'development') {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        app.quit();
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    buildMenu();
}

// ─────────────────────────────────────────────────────────────────────────────
//  菜单
// ─────────────────────────────────────────────────────────────────────────────
function buildMenu() {
    const tpl = [
        {
            label: '游戏',
            submenu: [
                {
                    label: '全屏 / 窗口',
                    accelerator: 'F11',
                    click: () => mainWindow && mainWindow.setFullScreen(!mainWindow.isFullScreen()),
                },
                { type: 'separator' },
                {
                    label: '退出',
                    accelerator: 'CmdOrCtrl+Q',
                    click: () => app.quit(),
                },
            ],
        },
        {
            label: '视图',
            submenu: [
                { label: '重新载入', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
                { label: '开发者工具', accelerator: 'F12',       click: () => mainWindow?.webContents.toggleDevTools() },
            ],
        },
        {
            label: '帮助',
            submenu: [
                {
                    label: '操作说明',
                    click: () => dialog.showMessageBox(mainWindow, {
                        type:    'info',
                        title:   '按键说明',
                        message: '战地射击 · 联机版',
                        detail:
                            'WASD   — 移动\n'   +
                            '鼠标   — 瞄准\n'   +
                            '左键   — 射击\n'   +
                            '右键   — 瞄准镜\n' +
                            'R      — 换弹\n'   +
                            '1/2/3  — 切换武器\n'+
                            'T      — 游戏内聊天\n'+
                            'Shift  — 奔跑\n'   +
                            'Esc    — 暂停',
                    }),
                },
                {
                    label: '关于',
                    click: () => dialog.showMessageBox(mainWindow, {
                        type:    'info',
                        title:   '关于',
                        message: '战地射击 v1.0.0',
                        detail:  '多人联机桌面版\n基于 Electron + Node.js + Socket.IO 构建',
                    }),
                },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ─────────────────────────────────────────────────────────────────────────────
//  IPC
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle('window-minimize', () => mainWindow?.minimize());
ipcMain.handle('window-maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('window-close',    () => mainWindow?.close());

// ─────────────────────────────────────────────────────────────────────────────
//  启动
// ─────────────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    try {
        await startEmbeddedServer();
    } catch (e) {
        console.error('[服务器启动失败]', e.message);
        dialog.showErrorBox('服务器启动失败', `${e.message}\n\n请检查 server/server.js 是否存在，或手动运行服务器后重试。`);
    }
    createMainWindow();
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

process.on('uncaughtException', err => {
    console.error('Uncaught:', err);
});
