/**
 * 预加载脚本：通过 contextBridge 安全暴露主进程能力给渲染进程
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codebuddy', {
  // 会话状态
  getSession: () => ipcRenderer.invoke('app:get-session'),
  // 登录
  openLogin: () => ipcRenderer.invoke('auth:open-login'),
  refreshCookies: () => ipcRenderer.invoke('auth:refresh-cookies'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  // 登录成功事件
  onLoginSuccess: (cb) => ipcRenderer.on('auth:login-success', cb),
  // 数据
  fetchUsage: (options) => ipcRenderer.invoke('usage:fetch', options),
  // 代理设置
  getProxy: () => ipcRenderer.invoke('proxy:get'),
  setProxy: (opts) => ipcRenderer.invoke('proxy:set', opts),
  testProxy: (opts) => ipcRenderer.invoke('proxy:test', opts),
  // 窗口控制
  closeWindow: () => ipcRenderer.invoke('window:close'),
  quitApp: () => ipcRenderer.invoke('window:quit'),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:set-always-on-top', flag),
  setOpacity: (value) => ipcRenderer.invoke('window:set-opacity', value),
  // 开机自启
  getAutoLaunch: () => ipcRenderer.invoke('app:get-auto-launch'),
  setAutoLaunch: (enable) => ipcRenderer.invoke('app:set-auto-launch', enable),
});
