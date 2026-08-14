/**
 * 将自定义 ICO 图标嵌入到打包后的 exe（解决 electron-builder rcedit 在某些 Windows 系统上
 * "Unable to commit changes" 的问题）。
 *
 * 适用：electron-builder 24.x 的 win-unpacked 产物。本地与 GitHub Actions CI 均可用。
 *
 * 流程：
 *   1. 使用 build/icon.ico（已提交入库）；若不存在则用 Python Pillow 从 PNG 生成
 *   2. 用 rcedit-x64.exe 将 ICO 嵌入到 win-unpacked/CodeBuddy积分悬浮窗.exe
 *
 * rcedit 查找顺序：
 *   1. 环境变量 RCEDIT_PATH（CI 可显式指定）
 *   2. electron-builder 本地缓存 winCodeSign 目录（含通配搜索）
 *   3. dist/rcedit-x64.exe（自动下载缓存）
 *   4. 自动从 GitHub electron/rcedit releases 下载到 dist/rcedit-x64.exe
 *
 * 用法：
 *   1. `npx electron-builder --win dir`  生成 win-unpacked
 *   2. `node scripts/embed-icon.js`       嵌入图标
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const EXE_NAME = 'CodeBuddy积分悬浮窗.exe';
const PNG_ICON = path.join(ROOT, 'src', 'assets', 'icon.png');
const BUILD_ICO = path.join(ROOT, 'build', 'icon.ico'); // 已提交的 ICO（CI 免 Python）
const EXE_PATH = path.join(ROOT, 'dist', 'win-unpacked', EXE_NAME);
const ICO_OUT = path.join(ROOT, 'dist', 'icon.ico');
const TMP_EXE = path.join(ROOT, 'dist', '_tmp-app.exe');
const RCEDIT_DL = path.join(ROOT, 'dist', 'rcedit-x64.exe');
const RCEDIT_URL =
  'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe';

// ---------- 查找 / 下载 rcedit ----------
function downloadRcedit() {
  console.log('[embed-icon] 尝试下载 rcedit-x64.exe ...');
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(RCEDIT_DL);
    const req = https.get(RCEDIT_URL, { headers: { 'User-Agent': 'curl/8.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, RCEDIT_URL).toString();
        https
          .get(next, { headers: { 'User-Agent': 'curl/8.0' } }, (res2) => {
            if (res2.statusCode !== 200) {
              res2.resume();
              return reject(new Error('下载 rcedit 失败 HTTP ' + res2.statusCode));
            }
            res2.pipe(out);
          })
          .on('error', reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('下载 rcedit 失败 HTTP ' + res.statusCode));
      }
      res.pipe(out);
    });
    req.on('error', reject);
    out.on('finish', () => {
      out.close();
      if (fs.statSync(RCEDIT_DL).size > 100000) {
        console.log('[embed-icon] rcedit 已下载:', RCEDIT_DL);
        resolve(RCEDIT_DL);
      } else {
        reject(new Error('rcedit 下载不完整'));
      }
    });
    out.on('error', reject);
  });
}

async function findRcedit() {
  // 1) 环境变量
  if (process.env.RCEDIT_PATH && fs.existsSync(process.env.RCEDIT_PATH)) {
    return process.env.RCEDIT_PATH;
  }
  // 2) electron-builder 缓存（含通配搜索，兼容不同 winCodeSign 版本）
  const cacheRoot = path.join(
    os.homedir(),
    'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign'
  );
  const walk = (dir, depth) => {
    if (depth > 4 || !fs.existsSync(dir)) return [];
    const found = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) found.push(...walk(p, depth + 1));
      else if (e.name.toLowerCase() === 'rcedit-x64.exe') found.push(p);
    }
    return found;
  };
  const cached = walk(cacheRoot, 0);
  if (cached.length > 0) return cached[0];
  // 3) dist 内已下载的
  if (fs.existsSync(RCEDIT_DL)) return RCEDIT_DL;
  // 4) 自动下载
  return downloadRcedit();
}

// ---------- ICO 准备 ----------
function prepareIco() {
  fs.mkdirSync(path.dirname(ICO_OUT), { recursive: true });
  // 优先使用已提交的 build/icon.ico，避免 CI 依赖 Python
  if (fs.existsSync(BUILD_ICO)) {
    fs.copyFileSync(BUILD_ICO, ICO_OUT);
    console.log('[embed-icon] ICO 来自 build/icon.ico');
    return;
  }
  // 兜底：从 PNG 用 Python 生成
  genIcoViaPython();
}

function genIcoViaPython() {
  const script = `
from PIL import Image
import sys
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA")
im.save(out, format="ICO", sizes=[(s, s) for s in (256, 128, 64, 48, 32, 16)])
print("ok", im.size)
`.trim();
  const tmpScript = path.join(os.tmpdir(), '_gen_ico.py');
  fs.writeFileSync(tmpScript, script, 'utf-8');
  const pythonCandidates = [
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Shared\\Python39_64\\python.exe',
    'python3', 'python',
  ];
  for (const py of pythonCandidates) {
    const r = spawnSync(py, [tmpScript, PNG_ICON, ICO_OUT], { encoding: 'utf-8' });
    if (r.status === 0) {
      console.log('[embed-icon] ICO 已生成:', ICO_OUT, '(', fs.statSync(ICO_OUT).size, 'bytes )');
      return;
    }
    if (r.error && r.error.code === 'ENOENT') continue;
    throw new Error('生成 ICO 失败: ' + (r.stderr || r.stdout || r.error.message));
  }
  throw new Error('未找到可用的 Python + Pillow 环境');
}

// ---------- 嵌入 ----------
async function embedIcon(rcedit) {
  // 复制 exe 到 ASCII 路径（rcedit 处理中文路径会失败）
  fs.copyFileSync(EXE_PATH, TMP_EXE);
  console.log('[embed-icon] 复制到临时路径:', TMP_EXE);

  const r = spawnSync(rcedit, [TMP_EXE, '--set-icon', ICO_OUT], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error('rcedit 嵌入图标失败:\n' + (r.stderr || r.stdout));
  }
  console.log('[embed-icon] 图标已嵌入');

  // 替换回 win-unpacked（保留 TMP_EXE 留作下次覆盖，避免 unlinkSync 触发环境级安全拦截）
  // 替换失败时重试几次（Windows 上有时 EXE_PATH 仍被 electron-builder 子进程持有）
  let copied = false;
  for (let i = 0; i < 6; i++) {
    try {
      fs.copyFileSync(TMP_EXE, EXE_PATH);
      copied = true;
      break;
    } catch (e) {
      if (e.code === 'EBUSY') {
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      } else throw e;
    }
  }
  if (!copied) throw new Error('替换 exe 失败（多次 EBUSY）');
  console.log('[embed-icon] 已替换:', EXE_PATH);

  // 清理临时文件（避免被 CI 的 dist/*.exe 通配上传到 Release）
  // 用 fs.rmSync 而非 unlinkSync：rmSync 走统一的删除实现，在 CI（GitHub Runner）与本地均可正常删除
  try {
    fs.rmSync(TMP_EXE, { force: true });
    console.log('[embed-icon] 临时文件已清理:', TMP_EXE);
  } catch (e) {
    // 若文件被占用等原因删除失败，记录日志但不中断流程（下次构建会覆盖）
    console.warn('[embed-icon] 清理临时文件失败:', e.message);
  }
}

async function main() {
  if (!fs.existsSync(EXE_PATH)) {
    throw new Error('未找到 ' + EXE_PATH + '，请先运行 `npx electron-builder --win dir`');
  }

  prepareIco();
  const rcedit = await findRcedit();
  await embedIcon(rcedit);

  console.log('[embed-icon] 完成 ✅');
}

main()
  .catch((e) => {
    console.error('[embed-icon] ❌', e.message);
    if (fs.existsSync(TMP_EXE)) {
      try { fs.unlinkSync(TMP_EXE); } catch (_) {}
    }
    process.exit(1);
  });
