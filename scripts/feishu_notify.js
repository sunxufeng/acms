#!/usr/bin/env node
/**
 * feishu_notify.js — 随时向飞书推送状态更新。
 *
 * 两种模式（由环境变量 FEISHU_NOTIFY_MODE 决定）：
 *   webhook  群机器人 Webhook：无需改应用权限。
 *            需要：FEISHU_NOTIFY_TARGET = Webhook 地址(URL)
 *                  可选 FEISHU_NOTIFY_SECRET = 自定义机器人签名密钥
 *   chat     应用机器人发到指定群聊：
 *            需要：FEISHU_NOTIFY_TARGET = chat_id
 *                  FEISHU_APP_ID / FEISHU_APP_SECRET（应用身份权限需开通 im:message:send_as_bot）
 *
 * 用法：
 *   node scripts/feishu_notify.js "标题" "第一行" "第二行" ...
 *   或管道： echo -e "行1\n行2" | node scripts/feishu_notify.js "标题"
 *
 * 环境变量可放在 /opt/acms/.env（与飞书凭证同文件）。
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function loadEnv() {
  const candidates = [
    process.env.ACMS_ENV_PATH,
    '/opt/acms/.env',
    path.resolve(__dirname, '..', '.env'),
  ];
  const env = {};
  for (const p of candidates) {
    if (!p || env.__loaded) continue;
    try {
      fs.readFileSync(p, 'utf8').split('\n').forEach((l) => {
        const i = l.indexOf('=');
        if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      });
      env.__loaded = true;
    } catch { /* ignore */ }
  }
  return env;
}

async function tenantToken(appId, appSecret) {
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('tenant_token: ' + JSON.stringify(j));
  return j.tenant_access_token;
}

function buildCard(title, lines) {
  const contentLines = lines.map((t) => ({ tag: 'text', text: t }));
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template: 'blue',
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
        { tag: 'hr' },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: 'ACMS 开发状态推送 · ' + new Date().toLocaleString('zh-CN') },
          ],
        },
      ],
    },
  };
}

function buildText(text) {
  return { msg_type: 'text', content: { text } };
}

function signWebhook(secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const stringToSign = timestamp + '\n' + secret;
  const sign = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
  return { timestamp, sign };
}

async function sendWebhook(target, secret, payload) {
  const body = { ...payload };
  if (secret && payload.msg_type !== 'text') {
    const { timestamp, sign } = signWebhook(secret);
    body.timestamp = timestamp;
    body.sign = sign;
  }
  const r = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('webhook http ' + r.status + ' ' + t);
  return t;
}

async function sendChat(appId, appSecret, chatId, payload) {
  const tk = await tenantToken(appId, appSecret);
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: chatId, ...payload }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('chat http ' + r.status + ' ' + t);
  return t;
}

async function main() {
  const env = loadEnv();
  const mode = (env.FEISHU_NOTIFY_MODE || 'webhook').toLowerCase();
  const target = env.FEISHU_NOTIFY_TARGET;
  if (!target) {
    console.error('缺少 FEISHU_NOTIFY_TARGET（webhook 地址或 chat_id）');
    process.exit(2);
  }

  const args = process.argv.slice(2);
  let title = args[0] || 'ACMS 状态更新';
  let lines;
  if (args.length > 1) {
    lines = args.slice(1);
  } else {
    const piped = fs.readFileSync(0, 'utf8').trim();
    lines = piped ? piped.split('\n') : ['(无内容)'];
  }

  const payload = buildCard(title, lines);
  let res;
  if (mode === 'chat') {
    res = await sendChat(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET, target, payload);
  } else {
    res = await sendWebhook(target, env.FEISHU_NOTIFY_SECRET, payload);
  }
  console.log('OK ' + res);
}

main().catch((e) => {
  console.error('NOTIFY_FAIL ' + e.message);
  process.exit(1);
});
