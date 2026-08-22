#!/usr/bin/env node
/**
 * wifi-helper —— 本机 WiFi 信息小工具（零依赖）
 *
 * 作用：读取「本机当前连接的 WiFi」名称(SSID)与最佳努力的 BSSID，
 *       通过本地 HTTP 暴露给管理页面，实现「一键填入本机 WiFi」。
 *
 * 用法：
 *   node scripts/wifi-helper.mjs
 *   # 可选自定义端口： WIFI_HELPER_PORT=9000 node scripts/wifi-helper.mjs
 *
 * 页面访问： http://127.0.0.1:8787/current-wifi  -> { ssid, bssid }
 *
 * 注意：浏览器无法主动读取 WiFi，因此必须在本机运行此进程并保持开启；
 *       且管理页需通过 http（如本地 dev http://localhost:3000）打开，
 *       从 https 页面跨源 fetch http://127.0.0.1 会被混合内容策略拦截。
 */
import http from 'node:http';
import { exec } from 'node:child_process';
import os from 'node:os';

const PORT = Number(process.env.WIFI_HELPER_PORT || 8787);

/** 读取当前 WiFi 的 SSID 与 BSSID（BSSID 为最佳努力，读取失败则为空串） */
function getWifi() {
  const platform = os.platform();
  return new Promise((resolve) => {
    if (platform === 'darwin') {
      const ifaces = ['en0', 'en1'];
      const tryEn = (i) => {
        if (i >= ifaces.length) return resolve({ ssid: '', bssid: '' });
        exec(`networksetup -getairportnetwork ${ifaces[i]}`, (err, out) => {
          const m = String(out).match(/Current Wi-Fi Network:\s*(.+)/);
          if (m && m[1].trim()) {
            const airport = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';
            exec(`${airport} -I 2>/dev/null | awk '/BSSID/{print $2}'`, (_e2, bout) => {
              resolve({ ssid: m[1].trim(), bssid: String(bout).trim() });
            });
          } else {
            tryEn(i + 1);
          }
        });
      };
      tryEn(0);
    } else if (platform === 'linux') {
      exec("nmcli -t -f active,ssid,bssid dev wifi 2>/dev/null | grep '^yes'", (err, out) => {
        const line = String(out).trim().split('\n')[0];
        if (line) {
          const parts = line.split(':');
          return resolve({ ssid: parts[1] || '', bssid: parts[2] || '' });
        }
        exec('iwgetid -r', (_e2, out2) => resolve({ ssid: String(out2).trim(), bssid: '' }));
      });
    } else if (platform === 'win32') {
      exec('netsh wlan show interfaces', (err, out) => {
        const s = String(out).match(/SSID\s+:\s(.+)/);
        const b = String(out).match(/BSSID\s+:\s(.+)/);
        resolve({ ssid: s ? s[1].trim() : '', bssid: b ? b[1].trim() : '' });
      });
    } else {
      resolve({ ssid: '', bssid: '' });
    }
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const url = (req.url || '').split('?')[0];
  if (url === '/current-wifi') {
    const info = await getWifi();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(200);
    return res.end(JSON.stringify(info));
  }
  if (url === '/health') {
    res.writeHead(200);
    return res.end('ok');
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[wifi-helper] listening on http://127.0.0.1:${PORT}/current-wifi`);
  console.log('[wifi-helper] 请保持此终端运行，并在本地 dev 页面(http://localhost:3000)点击「一键填入本机 WiFi」。');
});
