/**
 * 悬浮窗渲染进程逻辑
 */
const api = window.codebuddy;

const el = {
  loginMask: document.getElementById('login-mask'),
  app: document.getElementById('app'),
  btnLogin: document.getElementById('btn-login'),
  btnLoginOpen: document.getElementById('btn-login-open'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnTop: document.getElementById('btn-top'),
  btnClose: document.getElementById('btn-close'),
  btnOpacity: document.getElementById('btn-opacity'),
  opacityPanel: document.getElementById('opacity-panel'),
  opacitySlider: document.getElementById('opacity-slider'),
  opacityValue: document.getElementById('opacity-value'),
  sumRequests: document.getElementById('sum-requests'),
  sumCredits: document.getElementById('sum-credits'),
  usageList: document.getElementById('usage-list'),
  footStatus: document.getElementById('foot-status'),
  footTime: document.getElementById('foot-time'),
  btnLogout: document.getElementById('btn-logout'),
  toast: document.getElementById('toast'),
};

let isTop = false; // 默认不置顶（避免遮挡登录窗口）
let toastTimer = null;

function toast(msg, dur = 2000) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), dur);
}

function showLogin() {
  el.loginMask.classList.remove('hidden');
  el.app.classList.add('hidden');
}

function showApp() {
  el.loginMask.classList.add('hidden');
  el.app.classList.remove('hidden');
}

function setStatus(text) {
  el.footStatus.textContent = text;
  el.footTime.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function formatCredit(v) {
  if (v === null || v === undefined) return '-';
  const n = Number(v);
  if (Number.isNaN(n)) return '-';
  return n.toFixed(2);
}

function formatTime(t) {
  if (!t) return '';
  const d = new Date(t.replace(' ', 'T'));
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(
    2,
    '0'
  )} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 渲染请求明细列表
function renderList(list) {
  el.usageList.innerHTML = '';
  if (!list || list.length === 0) {
    el.usageList.innerHTML = '<li class="empty">暂无积分使用记录</li>';
    return;
  }
  list.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'usage-item';

    const top = document.createElement('div');
    top.className = 'usage-top';

    const model = document.createElement('span');
    model.className = 'usage-model';
    model.textContent = item.model || '未知模型';
    model.title = item.client || '';

    const credit = document.createElement('span');
    credit.className = 'usage-credit';
    credit.textContent = `${formatCredit(item.credit)} 积分`;

    top.appendChild(model);
    top.appendChild(credit);

    const time = document.createElement('div');
    time.className = 'usage-time';
    time.textContent = formatTime(item.requestTime);

    const input = document.createElement('div');
    input.className = 'usage-input';
    input.textContent = item.input || item.inputTrunc || '(无内容)';

    li.appendChild(top);
    li.appendChild(time);
    li.appendChild(input);
    el.usageList.appendChild(li);
  });
}

// 加载数据
async function loadData() {
  setStatus('加载中...');
  try {
    const res = await api.fetchUsage();
    const reqUsage = res.requestUsage || {};

    // 接口返回结构：{ code, data: { total, data: [...] } }
    // reqUsage.data.data 为主进程分页拉取的全部明细，用于积分统计
    const all = (reqUsage.data && Array.isArray(reqUsage.data.data)) ? reqUsage.data.data : [];
    const total = (reqUsage.data && reqUsage.data.total) || all.length || 0;

    // 汇总（基于全量数据统计，避免分页遗漏）
    el.sumRequests.textContent = String(total || 0);
    const totalCredit = all.reduce((s, it) => s + (Number(it.credit) || 0), 0);
    el.sumCredits.textContent = totalCredit.toFixed(1);

    // 列表只显示最近 30 条（接口按时间倒序，前 30 即最新）
    renderList(all.slice(0, 30));

    // 登录失效判断
    if (reqUsage.code === 401 || reqUsage.status === 401) {
      showLogin();
      toast('登录已失效，请重新扫码登录');
      return;
    }
    if (reqUsage.code !== 0 && reqUsage.code !== undefined) {
      const detail = reqUsage.status ? `（HTTP ${reqUsage.status}）` : '';
      toast((reqUsage.msg || '获取数据失败') + detail);
      setStatus((reqUsage.msg || '数据异常') + detail);
      return;
    }

    setStatus(`共 ${total} 条请求 · 已更新`);
  } catch (e) {
    console.error(e);
    setStatus('加载失败');
    toast('网络异常，请检查连接');
  }
}

// 初始化：检查会话
async function init() {
  try {
    const session = await api.getSession();
    if (session && session.hasSession) {
      showApp();
      loadData();
    } else {
      showLogin();
    }
  } catch (e) {
    console.error(e);
    showLogin();
  }
}

// 登录流程：
// 1. 调用 openLogin 打开 CodeBuddy 登录窗口
// 2. 用户扫码登录成功后，登录窗口会停留在"套餐与用量"页面（已登录）
// 3. 用户在悬浮窗点击"完成登录"，主进程从登录窗口捕获 cookie
// 4. 捕获成功后刷新主界面数据
async function doLogin() {
  toast('已打开登录窗口，请使用微信扫码登录');
  await api.openLogin();
  // 显示"在新窗口完成登录"按钮，引导用户登录后回来点击
  el.btnLoginOpen.style.display = 'block';
}

async function confirmLogin() {
  toast('正在获取登录状态...');
  const res = await api.refreshCookies();
  if (res && res.hasSession) {
    toast('登录成功');
    el.btnLoginOpen.style.display = 'none';
    showApp();
    loadData();
  } else {
    toast('尚未检测到登录态，请确认已扫码并完成登录');
  }
}

// ============ 事件绑定 ============
el.btnLogin.addEventListener('click', doLogin);
el.btnLoginOpen.addEventListener('click', confirmLogin);
el.btnRefresh.addEventListener('click', loadData);
// 左键：隐藏到托盘；右键：退出应用
el.btnClose.addEventListener('click', () => {
  api.closeWindow();
  toast('已隐藏到托盘，右键系统托盘图标可退出');
});
el.btnClose.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.quitApp();
});

el.btnTop.addEventListener('click', () => {
  isTop = !isTop;
  el.btnTop.classList.toggle('active', isTop);
  api.setAlwaysOnTop(isTop);
  toast(isTop ? '已置顶' : '已取消置顶');
});

// ============ 透明度调节 ============
// 当前透明度（0.4 ~ 1.0），默认 1.0
let currentOpacity = 1.0;

// 显示/隐藏透明度调节条
el.btnOpacity.addEventListener('click', () => {
  el.opacityPanel.classList.toggle('hidden');
});

// 滑块输入：实时调整窗口透明度
el.opacitySlider.addEventListener('input', () => {
  const percent = Number(el.opacitySlider.value); // 40 ~ 100
  currentOpacity = percent / 100;
  el.opacityValue.textContent = percent + '%';
  api.setOpacity(currentOpacity);
});

// 透明度调节条拖动时不触发拖拽
el.opacitySlider.addEventListener('mousedown', (e) => e.stopPropagation());

// ============ 退出登录 ============
// 点击后清除 cookie 并回到登录界面
el.btnLogout.addEventListener('click', async () => {
  el.btnLogout.disabled = true;
  toast('正在清除登录状态...', 1500);
  try {
    await api.logout();
    // 清除本地数据展示
    el.sumRequests.textContent = '-';
    el.sumCredits.textContent = '-';
    el.usageList.innerHTML = '';
    // 回到登录界面
    showLogin();
    toast('已退出登录');
  } catch (e) {
    console.error(e);
    toast('退出失败，请重试');
  } finally {
    el.btnLogout.disabled = false;
  }
});

// 登录成功事件：主进程检测到登录态后自动刷新界面
api.onLoginSuccess(() => {
  toast('登录成功');
  el.btnLoginOpen.style.display = 'none';
  showApp();
  loadData();
});

// 自动刷新（每 60 秒）
setInterval(() => {
  if (!el.app.classList.contains('hidden')) {
    loadData();
  }
}, 60000);

init();
