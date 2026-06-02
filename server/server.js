/**
 * 战地射击 - 多人联机服务器
 * Node.js + Express + Socket.IO
 *
 * 启动方式：
 *   npm install
 *   node server.js
 *
 * 端口：3000（HTTP / Socket.IO）
 */

'use strict';

const express   = require('express');
const http      = require('http');
const { Server} = require('socket.io');
const path      = require('path');
const crypto    = require('crypto');
const fs        = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
//  账号持久化（JSON 文件，生产环境可换 SQLite）
// ─────────────────────────────────────────────────────────────────────────────
// 数据目录优先级：
//   1. ACCOUNTS_DIR 环境变量（Electron 桌面版注入）
//   2. /data 目录（Render.com 持久磁盘挂载点）
//   3. __dirname（本地运行 / Railway 临时存储）
function getDataDir() {
    if (process.env.ACCOUNTS_DIR) return process.env.ACCOUNTS_DIR;
    const renderMount = '/data';
    try {
        if (!fs.existsSync(renderMount)) fs.mkdirSync(renderMount, { recursive: true });
        fs.accessSync(renderMount, fs.constants.W_OK);
        return renderMount;
    } catch (_) { /* 没有 /data 则用本地 */ }
    return __dirname;
}
const ACCOUNTS_FILE = path.join(getDataDir(), 'accounts.json');

// 结构：{ [phone]: { phone, name, passwordHash, playerId, createdAt } }
let accounts = {};

function loadAccounts() {
    try {
        if (fs.existsSync(ACCOUNTS_FILE)) {
            accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
            console.log(`[账号] 已加载 ${Object.keys(accounts).length} 个账号`);
        }
    } catch(e) {
        console.error('[账号] 加载失败，将使用空账号库', e.message);
        accounts = {};
    }
}

function saveAccounts() {
    try {
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
    } catch(e) {
        console.error('[账号] 保存失败:', e.message);
    }
}

function hashPassword(pwd) {
    // sha256(密码 + 固定盐)
    return crypto.createHash('sha256')
        .update('battlefield_2024_salt:' + pwd)
        .digest('hex');
}

function validatePhone(phone) {
    return /^1[3-9]\d{9}$/.test(String(phone).trim());
}

loadAccounts();

// ─────────────────────────────────────────────────────────────────────────────
//  配置
// ─────────────────────────────────────────────────────────────────────────────
const PORT            = process.env.PORT || 3000;
const TICK_RATE       = 20;          // 服务器广播频率 (Hz)
const MATCH_DURATION  = 300;         // 每局时长（秒）
const MAX_TEAMS       = 4;           // 最多4队
const PLAYERS_PER_TEAM= 2;           // 每队最多2人
const MAX_PLAYERS     = MAX_TEAMS * PLAYERS_PER_TEAM; // 8人
const SPAWN_MARGIN    = 8;           // 出生点离地图角落的偏移（格）
const MAP_GRID        = 40;          // 地图格数（和前端保持一致）

// 4个角落出生区域（前端坐标系，单元格尺寸=3）
const SPAWN_ZONES = [
    { team: 0, x:  SPAWN_MARGIN,         z:  SPAWN_MARGIN,         color: '#e74c3c', name: '红队' },
    { team: 1, x:  MAP_GRID - SPAWN_MARGIN, z: SPAWN_MARGIN,        color: '#3498db', name: '蓝队' },
    { team: 2, x:  SPAWN_MARGIN,         z:  MAP_GRID - SPAWN_MARGIN, color: '#2ecc71', name: '绿队' },
    { team: 3, x:  MAP_GRID - SPAWN_MARGIN, z: MAP_GRID - SPAWN_MARGIN, color: '#f39c12', name: '黄队' },
];

// ─────────────────────────────────────────────────────────────────────────────
//  内存数据库（生产环境可替换为 SQLite / Redis）
// ─────────────────────────────────────────────────────────────────────────────
const db = {
    players:    new Map(),   // socketId → playerData
    rooms:      new Map(),   // roomId   → roomData
    leaderboard:new Map(),   // playerId → {name, kills, deaths, wins, score}
    friendReqs: new Map(),   // playerId → Set<playerId>
    friends:    new Map(),   // playerId → Set<playerId>
    chatHistory:new Map(),   // channelId → [{from, msg, time}] (最近100条)
    skins:      new Map(),   // playerId → [skinId, ...]
    shopItems: [
        { id:'skin_desert',  name:'沙漠迷彩', price:200,  rarity:'普通', color:'#c8a96e' },
        { id:'skin_woodland',name:'丛林迷彩', price:300,  rarity:'普通', color:'#4a6a3b' },
        { id:'skin_arctic',  name:'北极迷彩', price:400,  rarity:'稀有', color:'#d8e8f0' },
        { id:'skin_urban',   name:'城市迷彩', price:500,  rarity:'稀有', color:'#8090a0' },
        { id:'skin_gold',    name:'金色皮肤', price:1000, rarity:'史诗', color:'#f5c518' },
        { id:'skin_neon',    name:'霓虹皮肤', price:1500, rarity:'传说', color:'#00ffff' },
    ],
    matchmakingQueue: {
        solo: [],   // [{socketId, playerId, joinTime}]
        duo:  [],   // [{socketId, playerId, teamCode, joinTime}]
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────────────────────────────────────
function genId(len = 8) {
    return crypto.randomBytes(len).toString('hex').slice(0, len);
}

function now() { return Date.now(); }

function getOrCreateLeaderboard(playerId, name) {
    if (!db.leaderboard.has(playerId)) {
        db.leaderboard.set(playerId, { id: playerId, name, kills: 0, deaths: 0, wins: 0, score: 0, highKills: 0 });
    }
    const lb = db.leaderboard.get(playerId);
    lb.name = name;  // 名称可能改变
    return lb;
}

function getTopLeaderboard(limit = 20) {
    return [...db.leaderboard.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

function getChatHistory(channelId) {
    return db.chatHistory.get(channelId) || [];
}

function pushChat(channelId, entry) {
    if (!db.chatHistory.has(channelId)) db.chatHistory.set(channelId, []);
    const hist = db.chatHistory.get(channelId);
    hist.push(entry);
    if (hist.length > 100) hist.shift();
}

// ─────────────────────────────────────────────────────────────────────────────
//  地图生成（与前端同步的随机迷宫，用于碰撞/出生点验证）
// ─────────────────────────────────────────────────────────────────────────────
function generateMaze(seed) {
    const G = MAP_GRID;
    const rng = mulberry32(seed);
    const grid = Array.from({ length: G }, () => new Uint8Array(G));

    // 递归分割算法（与前端保持一致）
    function divide(x1, y1, x2, y2) {
        if (x2 - x1 < 2 || y2 - y1 < 2) return;
        const horiz = (x2 - x1) <= (y2 - y1);
        if (horiz) {
            const wy = y1 + 1 + Math.floor(rng() * (y2 - y1 - 1));
            const px = x1 + Math.floor(rng() * (x2 - x1 + 1));
            for (let x = x1; x <= x2; x++) if (x !== px) grid[x][wy] = 1;
            divide(x1, y1, x2, wy - 1);
            divide(x1, wy + 1, x2, y2);
        } else {
            const wx = x1 + 1 + Math.floor(rng() * (x2 - x1 - 1));
            const pz = y1 + Math.floor(rng() * (y2 - y1 + 1));
            for (let z = y1; z <= y2; z++) if (z !== pz) grid[wx][z] = 1;
            divide(x1, y1, wx - 1, y2);
            divide(wx + 1, y1, x2, y2);
        }
    }
    divide(1, 1, G - 2, G - 2);
    return grid;
}

function mulberry32(seed) {
    let s = seed >>> 0;
    return function() {
        s += 0x6D2B79F5;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  匹配系统
// ─────────────────────────────────────────────────────────────────────────────
function tryMatchmaking() {
    const soloQ = db.matchmakingQueue.solo;
    const duoQ  = db.matchmakingQueue.duo;

    // 按最多等待时间排序
    soloQ.sort((a, b) => a.joinTime - b.joinTime);
    duoQ.sort((a, b) => a.joinTime - b.joinTime);

    // 尝试凑齐 4 队（每队 1-2 人）
    // 简化规则：凑够 4 个独立单位（solo 或 duo）即开局
    const units = [];

    // 先把等待超过30s的duo并入solo
    const now30 = now() - 30000;
    for (let i = duoQ.length - 1; i >= 0; i--) {
        if (duoQ[i].joinTime < now30 && !duoQ[i].partnerId) {
            soloQ.push(duoQ.splice(i, 1)[0]);
        }
    }

    // 收集可匹配的 duo 对
    const duoPairs = [];
    const usedDuo  = new Set();
    for (let i = 0; i < duoQ.length; i++) {
        if (usedDuo.has(i)) continue;
        for (let j = i + 1; j < duoQ.length; j++) {
            if (usedDuo.has(j)) continue;
            if (duoQ[i].teamCode && duoQ[i].teamCode === duoQ[j].teamCode) {
                duoPairs.push([duoQ[i], duoQ[j]]);
                usedDuo.add(i); usedDuo.add(j);
                break;
            }
        }
    }
    duoPairs.forEach(p => units.push({ type: 'duo', players: p }));

    // 剩余单人
    for (let i = 0; i < soloQ.length; i++) {
        units.push({ type: 'solo', players: [soloQ[i]] });
    }

    if (units.length < MAX_TEAMS) return null;

    // 取前4个单位组成一局
    const chosen = units.slice(0, MAX_TEAMS);
    const allSockets = chosen.flatMap(u => u.players.map(p => p.socketId));

    // 从队列中移除已匹配玩家
    const matchedSocketIds = new Set(allSockets);
    db.matchmakingQueue.solo = soloQ.filter(p => !matchedSocketIds.has(p.socketId));
    db.matchmakingQueue.duo  = duoQ.filter(p  => !matchedSocketIds.has(p.socketId));

    return createRoom(chosen);
}

function createRoom(units) {
    const roomId  = 'room_' + genId();
    const mapSeed = Math.floor(Math.random() * 0xFFFFFF);

    const teams = units.map((unit, teamIdx) => ({
        teamIdx,
        color:   SPAWN_ZONES[teamIdx].color,
        name:    SPAWN_ZONES[teamIdx].name,
        spawn:   SPAWN_ZONES[teamIdx],
        players: unit.players.map(p => p.socketId),
        alive:   unit.players.length,
    }));

    const room = {
        id:          roomId,
        mapSeed,
        teams,
        players:     {},   // socketId → {teamIdx, hp, pos, rot, kills, alive}
        state:       'starting',  // starting | playing | ending
        startTime:   now(),
        endTime:     now() + MATCH_DURATION * 1000,
        killFeed:    [],
        chatHistory: [],
        tickInterval: null,
    };

    // 分配玩家
    teams.forEach((team, ti) => {
        team.players.forEach((sid, pi) => {
            const spawn = SPAWN_ZONES[ti];
            const offsetX = (pi === 0 ? -1 : 1) * 1.5;
            room.players[sid] = {
                teamIdx: ti,
                hp:  100,
                pos: { x: (spawn.x + offsetX) * 3, y: 0.8, z: spawn.z * 3 },
                rot: { y: 0 },
                kills: 0,
                deaths: 0,
                alive: true,
                respawnTimer: 0,
            };
        });
    });

    db.rooms.set(roomId, room);
    return room;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Express + Socket.IO 启动
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout:  20000,
    pingInterval: 10000,
    // 支持 Railway / Render / Vercel 等平台的反向代理（WebSocket over HTTPS）
    transports: ['websocket', 'polling'],
});

// 信任反向代理（Railway / Render / Heroku 都在代理后面跑，需要这个才能获取正确 IP）
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));  // 服务游戏文件

// 健康检查 —— 云平台存活探针
app.get('/health', (_req, res) => res.json({ status: 'ok', players: db.players.size }));

// REST 接口
app.get('/api/leaderboard', (req, res) => {
    res.json(getTopLeaderboard(50));
});
app.get('/api/shop', (req, res) => {
    res.json(db.shopItems);
});
app.get('/api/player/:id', (req, res) => {
    const lb = db.leaderboard.get(req.params.id);
    if (!lb) return res.status(404).json({ error: 'not found' });
    const sk = db.skins.get(req.params.id) || [];
    res.json({ ...lb, skins: sk });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Socket.IO 事件处理
// ─────────────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[+] 玩家连接: ${socket.id}`);

    // ── 手机号注册 ────────────────────────────────────────────────────────────
    socket.on('auth:register', ({ phone, name, password }) => {
        phone = String(phone || '').trim();
        name  = String(name  || '').trim();
        password = String(password || '');

        // 格式校验
        if (!validatePhone(phone))
            return socket.emit('auth:error', { action: 'register', msg: '手机号格式不正确（需11位大陆手机号）' });
        if (!name || name.length < 2 || name.length > 16)
            return socket.emit('auth:error', { action: 'register', msg: '昵称需2~16个字符' });
        if (!password || password.length < 6)
            return socket.emit('auth:error', { action: 'register', msg: '密码至少6位' });
        if (accounts[phone])
            return socket.emit('auth:error', { action: 'register', msg: '该手机号已注册，请直接登录' });

        // 创建账号
        const playerId = 'p_' + genId(10);
        accounts[phone] = {
            phone,
            name,
            passwordHash: hashPassword(password),
            playerId,
            createdAt: Date.now(),
        };
        saveAccounts();
        getOrCreateLeaderboard(playerId, name);
        console.log(`[注册] ${phone} → ${name} (${playerId})`);

        socket.emit('auth:registerOk', { phone, name, playerId });
    });

    // ── 手机号登录 ────────────────────────────────────────────────────────────
    socket.on('auth:login', ({ phone, password }) => {
        phone    = String(phone    || '').trim();
        password = String(password || '');

        if (!validatePhone(phone))
            return socket.emit('auth:error', { action: 'login', msg: '手机号格式不正确' });
        if (!accounts[phone])
            return socket.emit('auth:error', { action: 'login', msg: '该手机号未注册，请先注册' });

        const acct = accounts[phone];
        if (acct.passwordHash !== hashPassword(password))
            return socket.emit('auth:error', { action: 'login', msg: '密码错误，请重试' });

        const pid   = acct.playerId;
        const name  = acct.name;
        const lb    = getOrCreateLeaderboard(pid, name);
        const skins = db.skins.get(pid) || [];

        db.players.set(socket.id, { socketId: socket.id, playerId: pid, name, teamCode: null });

        console.log(`[登录] ${phone} → ${name} (${pid})`);
        socket.emit('auth:loginOk', {
            playerId: pid,
            name,
            phone,
            score:  lb.score,
            kills:  lb.kills,
            deaths: lb.deaths,
            wins:   lb.wins,
            skins,
            shopItems: db.shopItems,
            leaderboard: getTopLeaderboard(20),
        });

        io.emit('lobby:online', io.engine.clientsCount);
    });

    // ── 大厅聊天 ─────────────────────────────────────────────────────────────
    socket.on('chat:lobby', ({ msg }) => {
        const player = db.players.get(socket.id);
        if (!player || !msg || msg.trim().length === 0) return;
        const entry = { from: player.name, fromId: player.playerId, msg: msg.trim().slice(0, 200), time: now() };
        pushChat('lobby', entry);
        io.emit('chat:lobby', entry);
    });

    // ── 私聊（好友） ─────────────────────────────────────────────────────────
    socket.on('chat:private', ({ toId, msg }) => {
        const player = db.players.get(socket.id);
        if (!player || !msg || msg.trim().length === 0) return;

        const channelId = [player.playerId, toId].sort().join('_');
        const entry = { from: player.name, fromId: player.playerId, toId, msg: msg.trim().slice(0, 200), time: now() };
        pushChat(channelId, entry);

        // 推送给对方在线 socket
        for (const [sid, p] of db.players) {
            if (p.playerId === toId) {
                io.to(sid).emit('chat:private', entry);
                break;
            }
        }
        socket.emit('chat:private', entry);  // 回显给自己
    });

    // ── 获取历史消息 ─────────────────────────────────────────────────────────
    socket.on('chat:history', ({ channelId }) => {
        socket.emit('chat:history', { channelId, messages: getChatHistory(channelId) });
    });

    // ── 好友系统 ─────────────────────────────────────────────────────────────
    socket.on('friend:add', ({ targetId }) => {
        const player = db.players.get(socket.id);
        if (!player) return;

        if (!db.friendReqs.has(targetId)) db.friendReqs.set(targetId, new Set());
        db.friendReqs.get(targetId).add(player.playerId);

        // 通知对方（如果在线）
        for (const [sid, p] of db.players) {
            if (p.playerId === targetId) {
                io.to(sid).emit('friend:request', { fromId: player.playerId, fromName: player.name });
                break;
            }
        }
        socket.emit('friend:addOk', { targetId });
    });

    socket.on('friend:accept', ({ fromId }) => {
        const player = db.players.get(socket.id);
        if (!player) return;

        const reqs = db.friendReqs.get(player.playerId);
        if (!reqs || !reqs.has(fromId)) return;
        reqs.delete(fromId);

        if (!db.friends.has(player.playerId)) db.friends.set(player.playerId, new Set());
        if (!db.friends.has(fromId))          db.friends.set(fromId, new Set());
        db.friends.get(player.playerId).add(fromId);
        db.friends.get(fromId).add(player.playerId);

        socket.emit('friend:list', { friends: [...(db.friends.get(player.playerId) || [])] });
        // 通知对方
        for (const [sid, p] of db.players) {
            if (p.playerId === fromId) {
                io.to(sid).emit('friend:list', { friends: [...(db.friends.get(fromId) || [])] });
                io.to(sid).emit('friend:accepted', { byId: player.playerId, byName: player.name });
                break;
            }
        }
    });

    socket.on('friend:list', () => {
        const player = db.players.get(socket.id);
        if (!player) return;
        const list = [...(db.friends.get(player.playerId) || [])];
        socket.emit('friend:list', { friends: list });
    });

    // ── 组队 ─────────────────────────────────────────────────────────────────
    socket.on('team:create', () => {
        const player = db.players.get(socket.id);
        if (!player) return;
        const code = genId(4).toUpperCase();
        player.teamCode = code;
        socket.emit('team:created', { code });
    });

    socket.on('team:join', ({ code }) => {
        const player = db.players.get(socket.id);
        if (!player) return;
        player.teamCode = code.toUpperCase();
        socket.emit('team:joined', { code: player.teamCode });
    });

    // ── 匹配队列 ─────────────────────────────────────────────────────────────
    socket.on('match:queue', ({ mode }) => {
        const player = db.players.get(socket.id);
        if (!player) return;

        // 防止重复入队
        removeFromQueue(socket.id);

        const entry = { socketId: socket.id, playerId: player.playerId, teamCode: player.teamCode, joinTime: now() };
        if (mode === 'duo' && player.teamCode) {
            db.matchmakingQueue.duo.push(entry);
        } else {
            db.matchmakingQueue.solo.push(entry);
        }

        socket.emit('match:queued', {
            mode,
            queuePos: db.matchmakingQueue.solo.length + db.matchmakingQueue.duo.length,
        });

        // 尝试立即匹配
        const room = tryMatchmaking();
        if (room) startRoom(room);
    });

    socket.on('match:cancel', () => {
        removeFromQueue(socket.id);
        socket.emit('match:cancelled');
    });

    // ── 游戏内同步 ───────────────────────────────────────────────────────────
    socket.on('game:move', ({ pos, rot, vel }) => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.state !== 'playing') return;
        const p = room.players[socket.id];
        if (!p || !p.alive) return;
        // 服务端只做简单合法性检查（防瞬移）
        const dx = pos.x - p.pos.x, dz = pos.z - p.pos.z;
        const distSq = dx*dx + dz*dz;
        if (distSq < 100) {  // 10单位/tick以内认为合法
            p.pos = pos;
            p.rot = rot;
        }
    });

    socket.on('game:shoot', ({ dir, weaponId }) => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.state !== 'playing') return;
        const player = db.players.get(socket.id);
        // 广播给同房间其他人（用于显示弹道特效）
        socket.to(room.id).emit('game:shoot', { fromId: socket.id, dir, weaponId });
    });

    socket.on('game:hit', ({ targetId, damage, weaponId }) => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.state !== 'playing') return;

        const attacker = room.players[socket.id];
        const target   = room.players[targetId];
        if (!attacker || !target || !target.alive) return;

        // 防止队友伤害
        if (attacker.teamIdx === target.teamIdx) return;

        target.hp -= damage;
        io.to(targetId).emit('game:damage', { damage, fromId: socket.id });

        if (target.hp <= 0) {
            target.hp = 0;
            target.alive = false;
            target.deaths++;
            attacker.kills++;

            // 积分（每次击杀+10）
            const attackerPlayer = db.players.get(socket.id);
            const targetPlayer   = db.players.get(targetId);
            if (attackerPlayer) {
                const lb = db.leaderboard.get(attackerPlayer.playerId);
                if (lb) { lb.kills++; lb.score += 10; }
            }
            if (targetPlayer) {
                const lb = db.leaderboard.get(targetPlayer.playerId);
                if (lb) lb.deaths++;
            }

            const killEntry = {
                killerId:   socket.id,
                killerName: attackerPlayer?.name || '未知',
                victimId:   targetId,
                victimName: targetPlayer?.name || '未知',
                weapon:     weaponId,
                time:       now(),
            };
            room.killFeed.push(killEntry);
            if (room.killFeed.length > 20) room.killFeed.shift();

            io.to(room.id).emit('game:kill', killEntry);
            io.to(targetId).emit('game:death', { killerId: socket.id, killerName: attackerPlayer?.name });

            // 5秒后复活
            target.respawnTimer = 5;
        }
    });

    socket.on('game:grenadeExplode', ({ pos, damage, radius }) => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.state !== 'playing') return;
        // 广播给所有人做特效
        io.to(room.id).emit('game:grenadeExplode', { fromId: socket.id, pos, damage, radius });
    });

    // ── 房间内聊天 ───────────────────────────────────────────────────────────
    socket.on('game:chat', ({ msg }) => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;
        const player = db.players.get(socket.id);
        const entry = { fromId: socket.id, name: player?.name || '?', msg: msg.trim().slice(0,100), time: now() };
        io.to(room.id).emit('game:chat', entry);
    });

    // ── 商店：购买皮肤 ───────────────────────────────────────────────────────
    socket.on('shop:buy', ({ skinId }) => {
        const player = db.players.get(socket.id);
        if (!player) return;
        const lb   = db.leaderboard.get(player.playerId);
        const item = db.shopItems.find(s => s.id === skinId);
        if (!lb || !item) return socket.emit('shop:buyFail', { reason: '商品不存在' });

        const skins = db.skins.get(player.playerId) || [];
        if (skins.includes(skinId)) return socket.emit('shop:buyFail', { reason: '已拥有此皮肤' });
        if (lb.score < item.price)  return socket.emit('shop:buyFail', { reason: '积分不足' });

        lb.score -= item.price;
        skins.push(skinId);
        db.skins.set(player.playerId, skins);
        socket.emit('shop:buyOk', { skinId, newScore: lb.score, skins });
    });

    // ── 断开连接 ─────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log(`[-] 玩家断开: ${socket.id}`);
        removeFromQueue(socket.id);

        const room = getRoomBySocket(socket.id);
        if (room) {
            delete room.players[socket.id];
            const player = db.players.get(socket.id);
            io.to(room.id).emit('game:playerLeft', { id: socket.id, name: player?.name });
            checkRoomEnd(room);
        }

        db.players.delete(socket.id);
        io.emit('lobby:online', io.engine.clientsCount);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
//  房间管理辅助
// ─────────────────────────────────────────────────────────────────────────────
function removeFromQueue(socketId) {
    db.matchmakingQueue.solo = db.matchmakingQueue.solo.filter(p => p.socketId !== socketId);
    db.matchmakingQueue.duo  = db.matchmakingQueue.duo.filter(p  => p.socketId !== socketId);
}

function getRoomBySocket(socketId) {
    for (const room of db.rooms.values()) {
        if (room.players[socketId]) return room;
    }
    return null;
}

function startRoom(room) {
    const allSockets = Object.keys(room.players);

    // 所有玩家加入 Socket.IO room
    allSockets.forEach(sid => {
        const s = io.sockets.sockets.get(sid);
        if (s) s.join(room.id);
    });

    room.state = 'playing';
    room.startTime = now();
    room.endTime   = now() + MATCH_DURATION * 1000;

    // 发送匹配成功事件
    io.to(room.id).emit('match:found', {
        roomId:    room.id,
        mapSeed:   room.mapSeed,
        teams:     room.teams,
        players:   buildPlayerList(room),
        duration:  MATCH_DURATION,
    });

    // 服务端 tick
    let tickCount = 0;
    room.tickInterval = setInterval(() => {
        tickCount++;
        const elapsed = (now() - room.startTime) / 1000;
        const remaining = Math.max(0, MATCH_DURATION - elapsed);

        // 复活逻辑
        for (const [sid, p] of Object.entries(room.players)) {
            if (!p.alive && p.respawnTimer > 0) {
                p.respawnTimer -= 1 / TICK_RATE;
                if (p.respawnTimer <= 0) {
                    respawnPlayer(room, sid);
                }
            }
        }

        // 广播游戏状态（每5tick一次降低带宽）
        if (tickCount % 5 === 0) {
            io.to(room.id).emit('game:state', {
                players:   buildPlayerList(room),
                remaining: Math.ceil(remaining),
                killFeed:  room.killFeed.slice(-5),
            });
        }

        // 比赛结束
        if (remaining <= 0) endRoom(room);
    }, 1000 / TICK_RATE);
}

function respawnPlayer(room, socketId) {
    const p = room.players[socketId];
    if (!p) return;
    const spawn = SPAWN_ZONES[p.teamIdx];
    p.hp    = 100;
    p.alive = true;
    p.pos   = { x: spawn.x * 3 + (Math.random() - 0.5) * 4, y: 0.8, z: spawn.z * 3 + (Math.random() - 0.5) * 4 };
    io.to(socketId).emit('game:respawn', { pos: p.pos, hp: p.hp });
}

function endRoom(room) {
    if (room.state === 'ending') return;
    room.state = 'ending';
    clearInterval(room.tickInterval);

    // 统计结果
    const results = room.teams.map(team => ({
        teamIdx:  team.teamIdx,
        teamName: team.name,
        color:    team.color,
        kills:    team.players.reduce((s, sid) => s + (room.players[sid]?.kills || 0), 0),
        players:  team.players.map(sid => {
            const p = room.players[sid];
            const pl = db.players.get(sid);
            return { id: sid, name: pl?.name || '?', kills: p?.kills || 0, deaths: p?.deaths || 0 };
        }),
    }));

    results.sort((a, b) => b.kills - a.kills);
    const winTeam = results[0];

    // 胜利队积分+50
    winTeam.players.forEach(rp => {
        const pl = db.players.get(rp.id);
        if (pl) {
            const lb = db.leaderboard.get(pl.playerId);
            if (lb) { lb.wins++; lb.score += 50; }
        }
    });

    io.to(room.id).emit('game:end', {
        results,
        winTeam:    winTeam.teamIdx,
        leaderboard: getTopLeaderboard(10),
    });

    // 60秒后清理房间
    setTimeout(() => db.rooms.delete(room.id), 60000);
}

function checkRoomEnd(room) {
    const aliveCount = Object.values(room.players).filter(p => p.alive).length;
    if (aliveCount <= 1 && Object.keys(room.players).length > 0) endRoom(room);
}

function buildPlayerList(room) {
    return Object.entries(room.players).map(([sid, p]) => {
        const pl = db.players.get(sid);
        return {
            id:      sid,
            name:    pl?.name || '?',
            teamIdx: p.teamIdx,
            hp:      p.hp,
            pos:     p.pos,
            rot:     p.rot,
            alive:   p.alive,
            kills:   p.kills,
        };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  定时匹配检查（每2秒）
// ─────────────────────────────────────────────────────────────────────────────
setInterval(() => {
    const qLen = db.matchmakingQueue.solo.length + db.matchmakingQueue.duo.length;
    if (qLen >= MAX_TEAMS) {
        const room = tryMatchmaking();
        if (room) startRoom(room);
    }
    // 更新大厅在线数
    io.emit('lobby:online', io.engine.clientsCount);
}, 2000);

// ─────────────────────────────────────────────────────────────────────────────
//  启动
// ─────────────────────────────────────────────────────────────────────────────
// 监听所有网络接口（0.0.0.0），Railway / Render 需要这个
httpServer.listen(PORT, '0.0.0.0', () => {
    const isCloud = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_URL;
    const publicUrl = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : process.env.RENDER_EXTERNAL_URL
        ? process.env.RENDER_EXTERNAL_URL
        : `http://localhost:${PORT}`;
    console.log(`
╔══════════════════════════════════════════╗
║        战地射击 - 联机服务器已启动       ║
║  本地地址: http://localhost:${PORT}          ║
║  公网地址: ${publicUrl.padEnd(32)}║
╚══════════════════════════════════════════╝
`);
});
