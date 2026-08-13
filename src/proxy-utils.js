/**
 * 代理工具函数（纯 Node，不依赖 Electron，可独立测试）
 *
 * 提供：代理地址解析、系统代理结果解析、HTTP(S) 代理 CONNECT 隧道、SOCKS5 代理隧道。
 * 供主进程 src/main.js 在网络请求走代理时使用。
 */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

// 读取环境变量中的代理地址（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 及其小写形式）
function getEnvProxy() {
  const keys = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'];
  for (const k of keys) {
    const v = process.env[k];
    if (v && /^(https?|socks4|socks5):\/\/\S+/.test(v.trim())) return v.trim();
  }
  return null;
}

// 解析代理地址字符串 -> { scheme, host, port, auth }，非法返回 null
function parseProxyUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!u.hostname) return null;
    let scheme = (u.protocol || 'http:').replace(':', '').toLowerCase();
    if (scheme === 'socks') scheme = 'socks5';
    if (!['http', 'https', 'socks4', 'socks5'].includes(scheme)) return null;
    let port = u.port ? Number(u.port) : 0;
    if (!port) port = scheme.startsWith('socks') ? 1080 : scheme === 'https' ? 443 : 80;
    return {
      scheme,
      host: u.hostname,
      port,
      auth: u.username
        ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password || '') }
        : null,
    };
  } catch (e) {
    return null;
  }
}

// 解析 resolveProxy 返回值（形如 "PROXY 127.0.0.1:7890;DIRECT"、"SOCKS5 host:port"、"DIRECT"）
function parseResolveProxyResult(result) {
  if (!result) return null;
  for (const part of String(result).split(';')) {
    const m = part.trim().match(/^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/i);
    if (m) {
      let scheme = m[1].toLowerCase();
      if (scheme === 'proxy') scheme = 'http';
      if (scheme === 'socks') scheme = 'socks5';
      const hostPort = m[2];
      const hp = hostPort.match(/^(.+):(\d+)$/);
      const host = hp ? hp[1] : hostPort;
      const port = hp ? Number(hp[2]) : scheme.startsWith('socks') ? 1080 : 80;
      return { proxy: { scheme, host, port, auth: null }, raw: hostPort };
    }
  }
  return null;
}

// 给 Promise 加超时
function withTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// HTTP(S) 代理：通过 CONNECT 建立到目标主机的 TLS 隧道并发送 HTTPS 请求
// 返回 Promise<{ status, data }>
function requestViaHttpProxy(options, proxy) {
  return new Promise((resolve, reject) => {
    const target = `${options.hostname}:${options.port || 443}`;
    const headers = { Host: target, 'Proxy-Connection': 'Keep-Alive' };
    if (proxy.auth) {
      headers['Proxy-Authorization'] =
        'Basic ' + Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`).toString('base64');
    }
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: target,
      headers,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败 (HTTP ${res.statusCode})`));
        return;
      }
      socket.setNoDelay(true);
      const tlsSocket = tls.connect({ socket, servername: options.hostname }, () => {
        const req = https.request(
          {
            hostname: options.hostname,
            port: options.port || 443,
            path: options.path,
            method: options.method || 'GET',
            headers: options.headers || {},
            agent: false,
            createConnection: () => tlsSocket,
          },
          (resp) => {
            let data = '';
            resp.on('data', (c) => (data += c));
            resp.on('end', () => resolve({ status: resp.statusCode, data }));
          }
        );
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
      });
      tlsSocket.on('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

// SOCKS5 代理：握手 + CONNECT，返回已连到目标主机的原始 socket
function socks5Connect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    sock.setNoDelay(true);
    let stage = 'greet';
    let pending = Buffer.alloc(0);
    const fail = (msg) => {
      sock.destroy();
      reject(new Error(msg));
    };

    const sendConnectReq = () => {
      const hostBuf = Buffer.from(host, 'utf8');
      sock.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ])
      );
      stage = 'connect';
      pending = Buffer.alloc(0);
    };

    sock.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (stage === 'greet') {
        if (pending.length < 2) return;
        if (pending[0] !== 0x05) return fail('SOCKS5 版本不支持');
        const method = pending[1];
        if (method === 0xff) return fail('SOCKS5 无可用的认证方式');
        if (method === 0x02 && proxy.auth) {
          const ub = Buffer.from(proxy.auth.user);
          const pb = Buffer.from(proxy.auth.pass);
          sock.write(Buffer.concat([Buffer.from([0x01, ub.length]), ub, Buffer.from([pb.length]), pb]));
          stage = 'auth';
          pending = Buffer.alloc(0);
        } else if (method === 0x00) {
          sendConnectReq();
        } else {
          fail('SOCKS5 需要认证但未提供账号密码');
        }
      } else if (stage === 'auth') {
        if (pending.length < 2) return;
        if (pending[1] !== 0x00) return fail('SOCKS5 认证失败');
        sendConnectReq();
      } else if (stage === 'connect') {
        if (pending.length < 4) return;
        const rep = pending[1];
        if (pending[0] !== 0x05 || rep !== 0x00) return fail(`SOCKS5 连接被拒绝 (REP=${rep})`);
        sock.removeAllListeners('data');
        resolve(sock);
      }
    });
    sock.on('error', reject);

    const methods = proxy.auth ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.concat([Buffer.from([0x05, methods.length]), Buffer.from(methods)]));
  });
}

// SOCKS5 代理：走隧道发送 HTTPS 请求，返回 Promise<{ status, data }>
function requestViaSocksProxy(options, proxy) {
  return new Promise((resolve, reject) => {
    socks5Connect(proxy, options.hostname, options.port || 443)
      .then((rawSocket) => {
        const tlsSocket = tls.connect({ socket: rawSocket, servername: options.hostname }, () => {
          const req = https.request(
            {
              hostname: options.hostname,
              port: options.port || 443,
              path: options.path,
              method: options.method || 'GET',
              headers: options.headers || {},
              agent: false,
              createConnection: () => tlsSocket,
            },
            (resp) => {
              let data = '';
              resp.on('data', (c) => (data += c));
              resp.on('end', () => resolve({ status: resp.statusCode, data }));
            }
          );
          req.on('error', reject);
          if (options.body) req.write(options.body);
          req.end();
        });
        tlsSocket.on('error', reject);
      })
      .catch(reject);
  });
}

module.exports = {
  getEnvProxy,
  parseProxyUrl,
  parseResolveProxyResult,
  withTimeout,
  socks5Connect,
  requestViaHttpProxy,
  requestViaSocksProxy,
};
