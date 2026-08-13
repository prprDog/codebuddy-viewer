/**
 * CodeBuddy 积分使用管理系统 - Electron 主进程
 *
 * 职责：
 *  - 管理悬浮列表主窗口（透明、置顶、半透明）
 *  - 管理登录窗口（内嵌 CodeBuddy 登录页，微信扫码登录）
 *  - 捕获并持久化登录后的会话 cookie
 *  - 调用 CodeBuddy 积分用量 API
 */
const { app, BrowserWindow, ipcMain, session, Menu, Tray, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
// 代理工具函数（纯 Node，可独立测试）
const {
  getEnvProxy,
  parseProxyUrl,
  parseResolveProxyResult,
  withTimeout,
  requestViaHttpProxy,
  requestViaSocksProxy,
} = require('./proxy-utils');

// ============ 单例锁：防止多开 ============
// 通过 requestSingleInstanceLock 保证同一时间只有一个应用实例。
// 若已有实例在运行，新的进程直接退出，并唤起已有实例的悬浮窗。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 用户再次启动程序时（如双击 exe），聚焦已有实例的窗口
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

// ============ 常量配置 ============
const CODUBUDDY_BASE = 'https://www.codebuddy.cn';
const LOGIN_URL = `${CODUBUDDY_BASE}/login?platform=usercenter&state=0&redirect_uri=${encodeURIComponent(CODUBUDDY_BASE + '/profile/plans-usage')}`;

// API 端点
const API_GET_USER_REQUEST_USAGE = '/billing/meter/get-user-request-usage'; // 请求明细
const API_GET_USER_DAILY_USAGE = '/billing/meter/get-user-daily-usage'; // 每日用量
const API_GET_USER_RESOURCE = '/billing/meter/get-user-resource'; // 资源/积分余额

// 会话数据存储路径
const SESSION_FILE = path.join(app.getPath('userData'), 'codebuddy-session.json');

// ============ 会话 Cookie 持久化 ============
function readSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  } catch (e) {
    return { cookies: [], savedAt: null };
  }
}

function writeSession(cookies) {
  const data = { cookies, savedAt: new Date().toISOString() };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// 从 CookieStore 提取 codebuddy.cn 域下的会话 cookie
async function captureCookies(win) {
  try {
    const cookies = await win.webContents.session.cookies.get({ domain: '.codebuddy.cn' });
    writeSession(cookies);
    return cookies;
  } catch (e) {
    console.error('捕获 cookie 失败:', e.message);
    return [];
  }
}

// 判断 cookie 集合是否仍有效（存在登录态关键 cookie）
function hasSessionCookies(cookies) {
  if (!cookies || cookies.length === 0) return false;
  return cookies.some(
    (c) => /token|session|sid|login|auth|user/i.test(c.name) || (c.name && c.name.length > 0)
  );
}

// ============ 窗口管理 ============
let mainWindow = null;
let loginWindow = null;
let tray = null;

// ---------- 窗口位置/大小记忆 ----------
const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

// 读取上次保存的窗口位置
function loadWindowState() {
  try {
    const raw = fs.readFileSync(WINDOW_STATE_FILE(), 'utf-8');
    const s = JSON.parse(raw);
    if (typeof s.x === 'number' && typeof s.y === 'number') {
      return { x: s.x, y: s.y, width: s.width, height: s.height };
    }
  } catch (e) {
    /* 无记录或损坏，忽略 */
  }
  return null;
}

// 保存当前窗口位置
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [x, y] = mainWindow.getPosition();
  const [width, height] = mainWindow.getSize();
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(
      WINDOW_STATE_FILE(),
      JSON.stringify({ x, y, width, height, savedAt: new Date().toISOString() }, null, 2),
      'utf-8'
    );
  } catch (e) {
    console.error('[main] 保存窗口位置失败:', e.message);
  }
}

// 防抖保存（拖拽过程连续触发，避免频繁写盘）
let saveStateTimer = null;
function scheduleSaveWindowState() {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(saveWindowState, 300);
}

// 校验窗口是否位于某个屏幕可见区域内（防止拔掉外接屏后窗口"消失"）
function isOnVisibleScreen(x, y, width, height) {
  const displays = screen.getAllDisplays();
  return displays.some((d) => {
    const wa = d.workArea;
    // 窗口至少 40px 与某个屏幕工作区相交
    const overlapX = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x);
    const overlapY = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y);
    return overlapX >= 40 && overlapY >= 40;
  });
}

// 计算创建窗口时应使用的初始位置
function getInitialWindowPosition(width, height) {
  const saved = loadWindowState();
  if (saved && isOnVisibleScreen(saved.x, saved.y, width, height)) {
    return { x: saved.x, y: saved.y };
  }
  // 无记录或不在可见区域内 -> 屏幕中央
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width: waW, height: waH } = display.workArea;
  return {
    x: Math.round(x + (waW - width) / 2),
    y: Math.round(y + (waH - height) / 2),
  };
}

// 计算创建窗口时应使用的尺寸（记住上次大小；异常值时回落默认）
function getInitialWindowSize() {
  const saved = loadWindowState();
  if (
    saved &&
    typeof saved.width === 'number' &&
    typeof saved.height === 'number' &&
    saved.width >= WIN_MIN_WIDTH &&
    saved.width <= WIN_MAX_WIDTH &&
    saved.height >= WIN_MIN_HEIGHT &&
    saved.height <= WIN_MAX_HEIGHT
  ) {
    return { width: Math.round(saved.width), height: Math.round(saved.height) };
  }
  return { width: WIN_WIDTH, height: WIN_HEIGHT };
}

// 应用图标路径（PNG 资源，打包后位于 asar 内）
function getAppIconPath() {
  return path.join(__dirname, 'assets', 'icon.png');
}

// 返回窗口/托盘可用的图标（nativeImage 或路径）
function getAppIcon() {
  try {
    const iconPath = getAppIconPath();
    if (fs.existsSync(iconPath)) return iconPath;
  } catch (e) {}
  return undefined;
}

// 生成托盘图标
// 注意：nativeImage 不支持 SVG（会得到空图像导致托盘图标空白），
// 因此使用 PNG 资源（src/assets/icon.png），并通过 asar 打包进应用。
function createTrayIcon() {
  // 优先从应用资源加载 PNG（打包后位于 asar 内，Electron 可自动读取）
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    if (fs.existsSync(iconPath)) {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) return img.resize({ width: 32, height: 32 });
    }
  } catch (e) {
    console.error('加载托盘图标失败:', e.message);
  }

  // 兜底：内嵌 1x1 透明 PNG，避免空图标
  const fallbackPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  return nativeImage.createFromDataURL('data:image/png;base64,' + fallbackPng);
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('CodeBuddy 积分悬浮窗');
  const menu = Menu.buildFromTemplate([
    { label: '显示/隐藏悬浮窗', click: () => toggleMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => toggleMainWindow());
}

// 显示/隐藏悬浮窗
function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// 默认窗口尺寸（等比例缩放基于此比例）
const WIN_WIDTH = 360; // 默认宽度
const WIN_HEIGHT = 560; // 默认高度
const WIN_ASPECT = WIN_WIDTH / WIN_HEIGHT; // 固定宽高比 9:14（等比例拉伸）
const WIN_MIN_WIDTH = 280;
const WIN_MIN_HEIGHT = 436; // 与最小宽度保持相同宽高比（280 / 0.642857 ≈ 436）
const WIN_MAX_WIDTH = 900;
const WIN_MAX_HEIGHT = 1400; // 与最大宽度保持相同宽高比（900 / 0.642857 ≈ 1400）

function createMainWindow() {
  const size = getInitialWindowSize();
  const pos = getInitialWindowPosition(size.width, size.height);

  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    // 默认不置顶：避免弹出登录窗口时被悬浮窗遮挡
    alwaysOnTop: false,
    resizable: true, // 允许拉伸
    minWidth: WIN_MIN_WIDTH,
    minHeight: WIN_MIN_HEIGHT,
    maxWidth: WIN_MAX_WIDTH,
    maxHeight: WIN_MAX_HEIGHT,
    skipTaskbar: true,
    hasShadow: false,
    icon: getAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 等比例拉伸：用户拖动窗口边缘时保持 9:14 宽高比
  mainWindow.setAspectRatio(WIN_ASPECT);

  // 在多桌面/全屏时可见（不改变置顶状态）
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 拖拽结束后保存窗口位置（Windows 上 moved 事件在移动完成后触发）
  mainWindow.on('moved', scheduleSaveWindowState);
  // 兜底：移动过程中也保存（部分平台可能只触发 move 而非 moved）
  mainWindow.on('move', scheduleSaveWindowState);
  // 拉伸结束保存尺寸
  mainWindow.on('resize', scheduleSaveWindowState);
  // 关闭/隐藏前立即同步保存（不依赖防抖定时器）
  mainWindow.on('close', () => {
    clearTimeout(saveStateTimer);
    saveWindowState();
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createLoginWindow() {
  if (loginWindow) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 480,
    height: 720,
    title: 'CodeBuddy 登录',
    autoHideMenuBar: true,
    icon: getAppIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:codebuddy', // 使用持久会话分区，保持登录态
    },
  });

  loginWindow.loadURL(LOGIN_URL);

  // 登录成功检测：当登录窗口导航到已登录页面时，自动捕获会话 cookie
  loginWindow.webContents.on('did-navigate', async () => {
    await tryAutoCapture();
  });
  loginWindow.webContents.on('did-navigate-in-page', async () => {
    await tryAutoCapture();
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

// 自动捕获登录状态：登录窗口加载了已登录页面（如 plans-usage）即视为登录成功
async function tryAutoCapture() {
  if (!loginWindow || loginWindow.isDestroyed()) return;
  const url = loginWindow.webContents.getURL();
  // 登录成功后会被 redirect 到 redirect_uri（/profile/plans-usage）
  if (url.includes('/profile')) {
    const cookies = await captureCookies(loginWindow);
    if (hasSessionCookies(cookies)) {
      // 通知主窗口刷新数据
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auth:login-success');
      }
      // 登录成功后自动关闭登录窗口
      setTimeout(() => {
        if (loginWindow && !loginWindow.isDestroyed()) {
          loginWindow.close();
        }
      }, 800);
    }
  }
}

// ============ API 调用 ============
// 首选方案：使用 Electron 登录会话分区（persist:codebuddy）的 fetch 发起请求。
// 优点：Chrome 网络栈会自动按域名/路径精确附加匹配的 cookie，既不会因 Cookie
//       头过大触发网关 400，也不会因遗漏鉴权 cookie 而 401，与真实浏览器行为一致。
// 回退方案：若会话分区 fetch 不可用，则手动拼 cookie 用 Node https 请求。

// 登录会话分区名（与登录窗口一致）
const SESSION_PARTITION = 'persist:codebuddy';

// ============ 代理配置 ============
// 生效优先级：手动配置(proxy-config.json) > 环境变量 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY > 系统代理自动检测
// 说明：Node https 回退请求默认不读系统代理，必须显式走代理；Electron 会话也在此统一显式设置，保证
//       登录窗口与会话分区 fetch 走同一代理，避免「浏览器能开、程序连不上」的问题。
const PROXY_FILE = () => path.join(app.getPath('userData'), 'proxy-config.json');
const API_HOST = 'www.codebuddy.cn';

// 当前生效的代理信息（main 进程 Node https 回退请求使用）
let activeProxyInfo = { source: 'none', proxy: null, raw: null };

function readProxyFile() {
  try {
    const raw = fs.readFileSync(PROXY_FILE(), 'utf-8');
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.proxy === 'string' && cfg.proxy.trim()) {
      return { proxy: cfg.proxy.trim(), enabled: cfg.enabled !== false };
    }
  } catch (e) {}
  return null;
}

function writeProxyFile(proxy, enabled) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(PROXY_FILE(), JSON.stringify({ proxy, enabled }, null, 2), 'utf-8');
  } catch (e) {
    console.error('[proxy] 保存配置失败:', e.message);
  }
}

// 确定当前应使用的代理
async function resolveEffectiveProxy() {
  const manual = readProxyFile();
  if (manual && manual.enabled) {
    const parsed = parseProxyUrl(manual.proxy);
    if (parsed) return { source: 'config', proxy: parsed, raw: manual.proxy };
  }
  const env = getEnvProxy();
  const envParsed = env ? parseProxyUrl(env) : null;
  if (envParsed) return { source: 'env', proxy: envParsed, raw: env };
  try {
    const result = await session.defaultSession.resolveProxy(CODUBUDDY_BASE);
    const sys = parseResolveProxyResult(result);
    if (sys) return { source: 'system', ...sys };
  } catch (e) {}
  return { source: 'none', proxy: null, raw: null };
}

// 将当前代理应用到 Electron 会话（登录窗口 + 会话分区 fetch）
async function applyProxyToSessions() {
  const proxy = activeProxyInfo && activeProxyInfo.proxy;
  const sessions = [session.defaultSession, session.fromPartition(SESSION_PARTITION)];
  for (const ses of sessions) {
    try {
      if (proxy) {
        const rules = `${proxy.scheme}://${proxy.host}:${proxy.port}`;
        await ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' });
      } else {
        await ses.setProxy({ mode: 'system' });
      }
    } catch (e) {
      console.error('[proxy] 应用代理到会话失败:', e.message);
    }
  }
}

async function setupProxy() {
  activeProxyInfo = await resolveEffectiveProxy();
  if (activeProxyInfo.source === 'none') {
    console.log('[proxy] 未检测到代理，使用系统默认网络（直连/系统代理）');
  } else {
    console.log(`[proxy] 使用代理(${activeProxyInfo.source}): ${activeProxyInfo.raw}`);
  }
  await applyProxyToSessions();
}

// 仅携带鉴权所需的关键 cookie，避免 Cookie 头过大导致网关 400（回退方案用）
function buildCookieStr(cookies) {
  if (!cookies || cookies.length === 0) return '';
  const pick = cookies.filter((c) =>
    /^session$|^session_2$|^tgw_l7_route$|^AUTH_SESSION_ID$|^KEYCLOAK_SESSION$/i.test(
      c.name
    )
  );
  const target = pick.length > 0 ? pick : cookies;
  return target.map((c) => `${c.name}=${c.value}`).join('; ');
}

function normalizeResponse(status, text) {
  // 401 表示登录失效
  if (status === 401) {
    return { code: 401, msg: '登录已失效，请重新登录', status };
  }
  // 400 可能是 Cookie 头过大等原因
  if (status === 400) {
    return { code: 400, msg: '请求被网关拒绝（可能 Cookie 过大）', status, raw: text.slice(0, 300) };
  }
  try {
    const json = JSON.parse(text);
    return json && typeof json === 'object' ? json : { code: -1, msg: '响应解析失败', status, raw: text.slice(0, 300) };
  } catch (e) {
    return { code: -1, msg: '响应解析失败', status, raw: text.slice(0, 300) };
  }
}

// 方案一：通过登录会话分区的 fetch 请求（自动携带匹配 cookie）
async function callApiViaSession(endpoint, payload) {
  const ses = session.fromPartition(SESSION_PARTITION);
  const resp = await ses.fetch(CODUBUDDY_BASE + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Platform': 'web',
      'Origin': CODUBUDDY_BASE,
      'Referer': CODUBUDDY_BASE + '/profile/plans-usage',
    },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  return normalizeResponse(resp.status, text);
}

// 方案二：手动拼 cookie 的 Node https 请求（回退，配置代理时自动走代理隧道）
function callApiViaNode(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const saved = readSession();
    const cookieStr = buildCookieStr(saved.cookies);
    const body = JSON.stringify(payload);
    const options = {
      hostname: API_HOST,
      port: 443,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cookie': cookieStr,
        'X-Client-Platform': 'web',
        'Origin': CODUBUDDY_BASE,
        'Referer': CODUBUDDY_BASE + '/profile/plans-usage',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
      body,
    };

    const proxy = activeProxyInfo && activeProxyInfo.proxy;
    let p;
    if (proxy && proxy.scheme.startsWith('socks')) {
      p = requestViaSocksProxy(options, proxy);
    } else if (proxy) {
      p = requestViaHttpProxy(options, proxy);
    } else {
      p = new Promise((res, rej) => {
        const req = https.request(options, (resp) => {
          let data = '';
          resp.on('data', (c) => (data += c));
          resp.on('end', () => res({ status: resp.statusCode, data }));
        });
        req.on('error', rej);
        req.write(body);
        req.end();
      });
    }
    p.then((r) => resolve(normalizeResponse(r.status, r.data))).catch(reject);
  });
}

// 统一入口：优先会话 fetch，失败则回退 Node https
async function callApi(endpoint, payload) {
  try {
    return await callApiViaSession(endpoint, payload);
  } catch (e) {
    console.error('会话 fetch 失败，回退 Node https:', e.message);
    try {
      return await callApiViaNode(endpoint, payload);
    } catch (e2) {
      const hint = activeProxyInfo && activeProxyInfo.proxy ? '（请检查代理设置）' : '（请检查网络或代理设置）';
      return { code: -2, msg: '网络请求失败' + hint + ': ' + e2.message, status: 0 };
    }
  }
}

// 计算本自然月起止时间（积分按自然月统计）
function monthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes()
    ).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  return { startTime: fmt(start), endTime: fmt(end) };
}

// ============ IPC 处理 ============
ipcMain.handle('app:get-session', async () => {
  const session = readSession();
  return { hasSession: hasSessionCookies(session.cookies), savedAt: session.savedAt };
});

ipcMain.handle('auth:open-login', async () => {
  createLoginWindow();
  return true;
});

// ============ 代理 IPC ============
ipcMain.handle('proxy:get', async () => {
  const fileCfg = readProxyFile();
  return {
    configured: fileCfg ? fileCfg.proxy : '',
    enabled: fileCfg ? fileCfg.enabled : true,
    active: activeProxyInfo,
  };
});

ipcMain.handle('proxy:set', async (_event, payload = {}) => {
  const proxy = typeof payload.proxy === 'string' ? payload.proxy.trim() : '';
  const enabled = payload.enabled !== false;
  if (proxy && !parseProxyUrl(proxy)) {
    return { ok: false, msg: '代理地址格式不正确，示例：http://127.0.0.1:7890' };
  }
  if (proxy) {
    writeProxyFile(proxy, enabled);
  } else {
    try {
      fs.unlinkSync(PROXY_FILE());
    } catch (e) {}
  }
  activeProxyInfo = await resolveEffectiveProxy();
  await applyProxyToSessions();
  return { ok: true, active: activeProxyInfo };
});

ipcMain.handle('proxy:test', async (_event, payload = {}) => {
  const proxyStr = typeof payload.proxy === 'string' ? payload.proxy.trim() : '';
  const parsed = proxyStr ? parseProxyUrl(proxyStr) : activeProxyInfo && activeProxyInfo.proxy;
  const opts = {
    hostname: API_HOST,
    port: 443,
    path: '/',
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CodeBuddy-Credit-Widget/1.0' },
  };
  const proxyLabel = proxyStr || (activeProxyInfo && activeProxyInfo.raw) || '系统默认(直连)';
  try {
    let p;
    if (!parsed) {
      p = new Promise((res, rej) => {
        const req = https.request(opts, (r) => res({ status: r.statusCode }));
        req.on('error', rej);
        req.end();
      });
    } else if (parsed.scheme.startsWith('socks')) {
      p = requestViaSocksProxy(opts, parsed);
    } else {
      p = requestViaHttpProxy(opts, parsed);
    }
    const r = await withTimeout(p, 10000, '连接超时（10 秒）');
    return { ok: r.status >= 200 && r.status < 500, status: r.status, proxy: proxyLabel };
  } catch (e) {
    return { ok: false, msg: e.message, proxy: proxyLabel };
  }
});

// 登录窗口完成捕获后触发：由渲染进程通知主进程刷新会话
ipcMain.handle('auth:refresh-cookies', async () => {
  if (loginWindow) {
    const cookies = await captureCookies(loginWindow);
    return { hasSession: hasSessionCookies(cookies), count: cookies.length };
  }
  return { hasSession: false, count: 0 };
});

ipcMain.handle('auth:logout', async () => {
  const ses = session.fromPartition('persist:codebuddy');
  try {
    // 清除 codebuddy.cn 域下所有 cookie（会话/身份/统计等）
    const cookies = await ses.cookies.get({ domain: '.codebuddy.cn' });
    for (const c of cookies) {
      try {
        await ses.cookies.remove(c.url || `https://${c.domain}${c.path || '/'}`, c.name);
      } catch (e) {}
    }
  } catch (e) {}
  // 清空分区存储数据
  try {
    await ses.clearStorageData();
  } catch (e) {}
  // 删除本地会话文件
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch (e) {}
  return true;
});

// 分页拉取某时间范围的积分使用明细（接口单页最多 100 条，循环翻页直到拉全）
async function fetchAllUsage(range) {
  const PAGE_SIZE = 100; // 接口单页上限
  const MAX_PAGES = 200; // 安全上限（防死循环）
  const all = [];
  let total = 0;
  let pageNum = 1;

  while (pageNum <= MAX_PAGES) {
    const res = await callApi(API_GET_USER_REQUEST_USAGE, {
      startTime: range.startTime,
      endTime: range.endTime,
      pageNum,
      pageSize: PAGE_SIZE,
    });

    // 鉴权失败 / 接口错误直接返回
    if (res.code === 401 || res.status === 401) {
      return { code: 401, msg: '登录已失效，请重新登录', status: 401 };
    }
    if (res.code !== 0) {
      return res;
    }

    const data = (res.data && Array.isArray(res.data.data)) ? res.data.data : [];
    total = (res.data && res.data.total) || 0;
    all.push(...data);

    // 已拉完所有数据
    if (data.length === 0 || all.length >= total) break;
    pageNum++;
  }

  return {
    code: 0,
    msg: 'OK',
    data: { total, data: all },
  };
}

ipcMain.handle('usage:fetch', async (event, options = {}) => {
  const range = monthRange();

  // 1) 分页拉取本月全部请求明细（用于积分统计）
  const requestUsage = await fetchAllUsage({
    startTime: options.startTime || range.startTime,
    endTime: options.endTime || range.endTime,
  });
  // 2) 每日用量（汇总）
  const dailyUsage = await callApi(API_GET_USER_DAILY_USAGE, {
    startTime: options.startTime || range.startTime,
    endTime: options.endTime || range.endTime,
  });
  // 3) 积分资源余额
  const resource = await callApi(API_GET_USER_RESOURCE, {});

  return { requestUsage, dailyUsage, resource };
});

ipcMain.handle('window:close', () => {
  // 关闭悬浮窗时隐藏到托盘，程序保持后台运行
  if (mainWindow) mainWindow.hide();
  return true;
});

// 关闭悬浮窗（隐藏到托盘）不退出应用
ipcMain.handle('window:quit', () => {
  app.quit();
  return true;
});

ipcMain.handle('window:set-always-on-top', (event, flag) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(!!flag, 'screen-saver');
  return true;
});

ipcMain.handle('window:set-opacity', (event, value) => {
  if (mainWindow && typeof value === 'number') {
    mainWindow.setOpacity(Math.min(1, Math.max(0.3, value)));
  }
  return true;
});

// ============ 应用生命周期 ============
app.whenReady().then(async () => {
  // 双保险：若未持有单例锁（第二个实例），立即退出，避免重复创建窗口
  if (!app.hasSingleInstanceLock()) {
    app.quit();
    return;
  }
  Menu.setApplicationMenu(null);
  await setupProxy(); // 先解析并应用代理，保证登录窗口与 API 请求都走同一网络配置
  createTray(); // 托盘常驻
  createMainWindow();
});

// 悬浮窗关闭（隐藏）后保持后台运行，通过托盘退出
app.on('window-all-closed', (e) => {
  // 不主动退出，保持托盘后台运行
});

app.on('before-quit', () => {
  // 退出前保存窗口位置与大小
  saveWindowState();
});
