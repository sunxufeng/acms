// @ts-nocheck
// 飞书开放平台客户端：获取 tenant_access_token 并发送文本消息。
// 仅在配置了 FEISHU_APP_ID / FEISHU_APP_SECRET 时可用（PoC 可直接跑，回复发送会被跳过）。

const FEISHU_HOST = 'https://open.feishu.cn';

// 多 App 支持：每个飞书应用（主应用 + 各智能体绑定的应用）缓存各自的 tenant_access_token。
// 默认（creds 为空）使用主应用的环境变量凭据。
const _tokenCache = new Map(); // appId -> { token, expAt }

/**
 * 获取 tenant_access_token。
 * @param {{appId?:string, appSecret?:string}} [creds] 不传则用主应用环境变量凭据
 * @returns {Promise<string|null>}
 */
export async function getTenantToken(creds) {
  const appId = creds?.appId || process.env.FEISHU_APP_ID;
  const appSecret = creds?.appSecret || process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;

  const cacheKey = appId;
  const now = Date.now();
  const hit = _tokenCache.get(cacheKey);
  if (hit && hit.token && now < hit.expAt) return hit.token;

  const res = await fetch(`${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取 tenant_access_token 失败: ${data.msg}`);
  _tokenCache.set(cacheKey, { token: data.tenant_access_token, expAt: now + (data.expire - 60) * 1000 });
  return data.tenant_access_token;
}

// 以机器人身份给指定 receive_id 发送文本消息。
// @param receiveId 接收方 ID（open_id 或 union_id，取决于 receiveIdType）
// @param creds 可选，指定用哪个飞书应用（智能体绑定的应用）的身份发送
// @param opts.receiveIdType 'open_id'(默认) | 'union_id'。union_id 在同一开发商旗下
//   各应用间稳定一致，是「用子应用(如观澜)身份给主应用用户发消息」的正确寻址方式。
export async function sendText(receiveId, text, creds, opts = {}) {
  const receiveIdType = opts.receiveIdType || 'open_id';
  const token = await getTenantToken(creds);
  if (!token) return { skipped: true, reason: '未配置飞书凭据' };

  const res = await fetch(`${FEISHU_HOST}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`发送飞书消息失败: ${data.msg}`);
  return { ok: true, messageId: data.data?.message_id };
}

// 把某个 open_id 解析成 union_id（同一开发商旗下稳定一致）。
// 需要调用方应用具备 contact:user.base:readonly 权限；无权限或解析失败返回 null。
const _unionCache = new Map(); // openId -> unionId
export async function resolveUnionId(openId, creds) {
  if (!openId) return null;
  if (_unionCache.has(openId)) return _unionCache.get(openId);
  const token = await getTenantToken(creds);
  if (!token) return null;
  try {
    const res = await fetch(
      `${FEISHU_HOST}/open-apis/contact/v3/users/${openId}?user_id_type=open_id`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (data.code === 0 && data.data?.user?.union_id) {
      _unionCache.set(openId, data.data.user.union_id);
      return data.data.user.union_id;
    }
  } catch {
    /* 权限不足/网络异常 → 静默返回 null，调用方退化为 open_id 寻址 */
  }
  return null;
}

// 下载飞书消息里的图片（用户发送的图片），转成 data URL 交给多模态模型。
// 注意：im/v1/images/{image_key} 只能下载「机器人自己上传」的图片；
// 要下载用户发来的图片/文件，必须用「消息资源」接口：
//   im/v1/messages/{message_id}/resources/{image_key}?type=image
// 因此需要传入 messageId（即消息里的 message_id）。
// creds：可选，指定下载所用的飞书应用（智能体应用的图片需由其自身 token 下载）。
const IMG_MAX_BYTES = 8 * 1024 * 1024; // 8MB 上限，超过拒绝（避免巨型 base64 撑爆请求/上下文）
export async function downloadImage(messageId, imageKey, creds) {
  const token = await getTenantToken(creds);
  if (!token) return null;
  const res = await fetch(
    `${FEISHU_HOST}/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`下载飞书图片失败 HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > IMG_MAX_BYTES) {
    throw new Error(`图片过大（约 ${Math.round(buf.length / 1024)}KB），上限 8MB，请发送更小的截图`);
  }
  const ct = res.headers.get('content-type') || 'image/png';
  const mime = ct.startsWith('image/') ? ct : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// 下载飞书消息里的文件（用户发送的文件），返回 { buffer, mime }。
// 与图片同理，必须用「消息资源」接口 im/v1/messages/{message_id}/resources/{file_key}?type=file，
// 而不能用 im/v1/files/{file_key}（那只支持机器人自己上传的文件）。
// 注意：飞书云文档（doc/sheet/bitable 等在线文档）走该接口也下载不到正文，调用方应先按 file_type 区分。
const FILE_MAX_BYTES = 25 * 1024 * 1024; // 25MB 上限
export async function downloadFile(messageId, fileKey, creds) {
  const token = await getTenantToken(creds);
  if (!token) return null;
  const res = await fetch(
    `${FEISHU_HOST}/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`下载飞书文件失败 HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > FILE_MAX_BYTES) {
    throw new Error(`文件过大（约 ${Math.round(buf.length / 1024 / 1024)}MB），上限 25MB，请发送更小的文件`);
  }
  const ct = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer: buf, mime: ct };
}

// ---------- 读取会话与消息（用于「总结我的任务 / 待办 / 卡点」等能力） ----------
// ⚠️ 权限边界（飞书平台安全模型）：机器人只能读取「它自己所在的会话」——
//   即 (a) 用户与它的私聊，(b) 用户把它拉进去的群聊。
//   无法读取用户与其它人的私聊、也无法读取未加入的群。下面接口均受此约束。

// 列出机器人所在的群聊（需要 im:chat 权限）。p2p 私聊不在此列表，
// 私聊历史需用消息事件里的 chat_id 直接读取。
// userAccessToken：若传入，则以「用户身份」列出该用户所在的所有会话（含私聊 p2p 与群），
// 这正是凌云自动化以创建者视角读取其私聊/群聊所需的能力。
export async function listBotChats({ pageSize = 100, creds, userAccessToken } = {}) {
  const token = userAccessToken || (await getTenantToken(creds));
  if (!token) return { error: '未配置飞书凭据' };
  const url = `${FEISHU_HOST}/open-apis/im/v1/chats?user_id_type=open_id&page_size=${Math.min(100, pageSize)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.code !== 0) return { error: `列出会话失败: ${data.msg}` };
  const items = (data.data && data.data.items) || [];
  return {
    chats: items.map((c) => ({
      chat_id: c.chat_id,
      name: c.name || (c.chat_type === 'p2p' ? '(私聊)' : '(未命名群)'),
      chat_type: c.chat_type, // 'group' | 'p2p'
      member_count: c.member_count,
      owner_open_id: c.owner_id,
    })),
  };
}

// 从一条消息里提取纯文本。飞书群里大量消息是「富文本(post)」而非纯 text，
// 必须把 post 也解析出来，否则会误判「群内没有可读文本」。
function extractMessageText(msg) {
  const type = msg.msg_type;
  // 飞书 im/v1/messages 返回的正文嵌套在 body.content（JSON 字符串）；
  // 个别旧版本/接口直接给 content，这里两者兼容。
  const raw = (msg.body && msg.body.content) || msg.content || '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  let text = '';
  if (type === 'text') {
    text = (parsed.text || '').trim();
  } else if (type === 'post') {
    // content: [ [ {tag:'text',text}, {tag:'at',text}, ... ], ... ]
    const lines = [];
    const blocks = parsed.content || parsed.content_v2 || [];
    for (const line of blocks) {
      if (!Array.isArray(line)) continue;
      const seg = line
        .map((el) => {
          if (el.tag === 'text') return el.text || '';
          if (el.tag === 'a') return el.text || el.href || '';
          if (el.tag === 'at') return `@${el.text || el.user_name || el.user_id || '某人'}`;
          return '';
        })
        .join('');
      if (seg) lines.push(seg);
    }
    text = lines.join('\n').trim();
  } else {
    return '';
  }
  // 把文本里的 @_user_N 占位替换为真实姓名（来自 messages 接口的 mentions 字段），
  // 否则总结里的人名会是 @_user_1 这样的占位，无法识别负责人。
  const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
  for (const mn of mentions) {
    if (mn.key && mn.name) text = text.split(mn.key).join(mn.name);
  }
  return text;
}

// 读取某个会话的历史消息（需要 im:message:readonly）。
// container_id_type 合法值为 chat（群聊）或 p2p（私聊），注意不是 chat_id！
// 同时解析 text 与 post（富文本）类型；并带回类型分布，便于区分
// 「API 真的没返回消息」还是「返回了但被类型过滤掉」。
// userAccessToken：若传入，则以「用户身份」读取该用户所在会话（私聊/群）的消息。
export async function getChatMessages({ chatId, pageSize = 50, days, containerType = 'chat', creds, userAccessToken } = {}) {
  const token = userAccessToken || (await getTenantToken(creds));
  if (!token) return { error: '未配置飞书凭据' };
  if (!chatId) return { error: '缺少 chat_id' };
  // 防御：合法值只允许 chat / p2p，避免再次踩 invalid container_id_type 的坑
  const type = containerType === 'p2p' ? 'p2p' : 'chat';
  const url =
    `${FEISHU_HOST}/open-apis/im/v1/messages` +
    `?container_id=${encodeURIComponent(chatId)}&container_id_type=${type}` +
    `&sort_type=ByCreateTimeDesc&page_size=${Math.min(50, pageSize)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.code !== 0) return { error: `读取消息失败: ${data.msg}` };
  const items = (data.data && data.data.items) || [];
  // 统计各类型数量，供上层诊断
  const typeCount = {};
  for (const m of items) typeCount[m.msg_type] = (typeCount[m.msg_type] || 0) + 1;
  let msgs = items
    .map((m) => {
      const text = extractMessageText(m);
      return {
        sender_open_id: m.sender && m.sender.id,
        create_time: Number(m.create_time) || 0,
        text,
        msg_type: m.msg_type,
      };
    })
    .filter((m) => m.text);
  if (days && days > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    msgs = msgs.filter((m) => m.create_time >= cutoff);
  }
  // 按时间正序，便于模型理解前后因果
  msgs.sort((a, b) => a.create_time - b.create_time);
  return {
    messages: msgs,
    // 原始条目（含 content 原文），供诊断/调试展示真实消息结构
    rawItems: items.map((m) => ({ msg_type: m.msg_type, sender: m.sender, content: (m.body && m.body.content) || m.content })),
    diagnostics: {
      total: items.length,
      typeCount,
      readable: msgs.length,
    },
  };
}

let _nameCache = new Map();
// 批量把 open_id 解析成姓名（contact:user.base:readonly，best-effort；失败则回退 open_id）。
// creds：可选，指定用哪个飞书应用的 token 解析（智能体应用读自己会话时的成员姓名）。
export async function resolveUserNames(openIds, creds) {
  const unique = [...new Set(openIds.filter(Boolean))];
  const out = {};
  const todo = [];
  for (const id of unique) {
    if (_nameCache.has(id)) out[id] = _nameCache.get(id);
    else todo.push(id);
  }
  if (!todo.length) return out;
  const token = await getTenantToken(creds);
  if (!token) {
    for (const id of todo) out[id] = id;
    return out;
  }
  try {
    const res = await fetch(`${FEISHU_HOST}/open-apis/contact/v3/users/batch_get?user_id_type=open_id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ user_ids: todo }),
    });
    const data = await res.json();
    if (data.code === 0 && data.data && data.data.items) {
      for (const u of data.data.items) {
        const name = u.name || u.open_id;
        if (name) {
          out[u.open_id] = name;
          _nameCache.set(u.open_id, name);
        }
      }
    }
  } catch {
    /* 权限不足或网络异常时静默回退为 open_id */
  }
  for (const id of todo) if (!out[id]) out[id] = id;
  return out;
}

// 把 Markdown 渲染成飞书互动卡片（卡片内 markdown 元素可正常渲染排版）
// 超过卡片上限或发送失败时，回退为纯文本（剥离 markdown 语法）
const CARD_MD_LIMIT = 4000;

export function stripMarkdown(md = '') {
  return md
    .replace(/```[\s\S]*?```/g, (m) => '\n' + m.replace(/```/g, '').trim() + '\n')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/#{1,6}\s?/g, '')
    .replace(/^>\s?/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, '• ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 飞书互动卡片的 markdown 元素**不支持 # 标题语法**（会原样显示成 ## 字面字符），
// 也**不支持 > 块引用语法**（会原样显示成 > 字面字符）。
// 处理：标题行转加粗；块引用行转斜体（连续多行合并为一段），保证卡片里不再出现裸 # / >。
export function cardMarkdown(md = '') {
  const lines = (md || '').split('\n');
  const out = [];
  let quoteBuf = null;
  const flushQuote = () => {
    if (quoteBuf === null) return;
    const t = quoteBuf.join(' ').trim();
    quoteBuf = null;
    if (t) out.push(`*${t}*`); // 飞书卡片支持 *斜体*
  };
  for (const line of lines) {
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      if (quoteBuf === null) quoteBuf = [];
      quoteBuf.push(q[1].trim());
      continue;
    }
    flushQuote();
    const m = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const level = m[1].length;
    const text = m[2].trim();
    // 一/二级标题用加粗，三级及以下加粗 + 前缀，避免与正文混在一起
    if (level <= 2) out.push(`**${text}**`);
    else out.push(`· **${text}**`);
  }
  flushQuote();
  return out.join('\n');
}

// ---------- 飞书云盘（Drive）操作：以用户身份（user_access_token）读写个人/已授权云盘 ----------
// 注意：这些接口必须在「用户已授权 drive 权限」的前提下，用用户的 user_access_token 调用；
// tenant_access_token 只能访问应用被显式授权/挂载的空间，访问不了用户的个人云盘。
// folderToken 来自云盘链接 .../folder/<token>。

// 列出某个文件夹下的文件与子文件夹
export async function listDriveFiles({ folderToken, pageSize = 50, userAccessToken }: { folderToken: string; pageSize?: number; userAccessToken: string }) {
  if (!userAccessToken) return { error: '缺少用户飞书令牌（未授权云盘）' };
  const url = `${FEISHU_HOST}/open-apis/drive/v1/files?folder_token=${encodeURIComponent(folderToken)}&page_size=${Math.min(100, pageSize)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${userAccessToken}` } });
  const data = await res.json();
  if (data.code !== 0) return { error: `列出云盘文件失败: ${data.msg}` };
  const files = ((data.data && data.data.files) || []).map((f: Record<string, any>) => ({
    file_token: f.file_token || f.token,
    name: f.name,
    type: f.type, // 'file' | 'folder'
    parent_token: f.parent_token,
  }));
  return { files, next_page_token: (data.data && data.data.next_page_token) || '' };
}

// 移动文件/文件夹到目标文件夹。type: 'file' | 'folder'
export async function moveDriveFile({ fileToken, destFolderToken, type = 'file', userAccessToken }: { fileToken: string; destFolderToken: string; type?: 'file' | 'folder'; userAccessToken: string }) {
  if (!userAccessToken) return { error: '缺少用户飞书令牌（未授权云盘）' };
  const res = await fetch(`${FEISHU_HOST}/open-apis/drive/v1/files/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${userAccessToken}` },
    body: JSON.stringify({ file_token: fileToken, folder_token: destFolderToken, type }),
  });
  const data = await res.json();
  if (data.code !== 0) return { error: `移动文件失败: ${data.msg}` };
  return { ok: true, file_token: (data.data && data.data.file_token) || fileToken };
}

// 复制文件到目标文件夹（保留源文件）。
// 飞书复制文档接口：POST /open-apis/drive/explorer/v2/file/copy/files/:fileToken
//   - fileToken 放在 URL 路径里（不是 body）
//   - body 用 dstFolderToken（目标文件夹）+ dstName（副本名称），不是 folder_token/name
//   - 响应新文件 token 在 data.data.token
export async function copyDriveFile({ fileToken, destFolderToken, name, type = 'file', userAccessToken }: { fileToken: string; destFolderToken: string; name?: string; type?: string; userAccessToken: string }) {
  if (!userAccessToken) return { error: '缺少用户飞书令牌（未授权云盘）' };
  const body: Record<string, any> = { type, dstFolderToken: destFolderToken };
  if (name) body.dstName = name;
  const res = await fetch(`${FEISHU_HOST}/open-apis/drive/explorer/v2/file/copy/files/${fileToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${userAccessToken}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.code !== 0) return { error: `复制文件失败: ${data.msg}` };
  return { ok: true, file_token: (data.data && data.data.token) || '' };
}

// 下载云盘文件内容（用于「内容一致则不复制」的查重）。
// 飞书下载接口 GET /open-apis/drive/v1/files/:file_token/download：
//   - 多数情况直接返回文件二进制（fetch 跟随 302）；
//   - 个别情况返回 JSON（data.url / data.download_url 为临时直链），再二次拉取。
export async function downloadDriveFile({ fileToken, userAccessToken }: { fileToken: string; userAccessToken: string }) {
  if (!userAccessToken) return { error: '缺少用户飞书令牌（未授权云盘）' };
  const url = `${FEISHU_HOST}/open-apis/drive/v1/files/${fileToken}/download`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${userAccessToken}` }, redirect: 'follow' });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { error: `下载文件失败 HTTP ${res.status}: ${t.slice(0, 200)}` };
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const data = await res.json().catch(() => null);
    if (data && data.code !== 0) return { error: `下载文件失败: ${data.msg}` };
    const realUrl = data && data.data && (data.data.url || data.data.download_url);
    if (realUrl) {
      const r2 = await fetch(realUrl);
      if (!r2.ok) return { error: `下载文件失败 HTTP ${r2.status}` };
      const buf = Buffer.from(await r2.arrayBuffer());
      return { ok: true, content: buf, size: buf.length };
    }
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, content: buf, size: buf.length };
}

// 分页列出某文件夹下所有文件与子文件夹（自动翻页，避免一次性超过 page_size 上限）
export async function listDriveFilesAll({ folderToken, userAccessToken }: { folderToken: string; userAccessToken: string }) {  const all: Array<{ file_token: string; name: string; type: string; parent_token?: string }> = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) {
    const r = await listDriveFiles({ folderToken, pageSize: 100, userAccessToken });
    if (r && r.error) return { error: r.error };
    const files = (r && r.files) || [];
    all.push(...files);
    pageToken = (r && r.next_page_token) || '';
    if (!pageToken || !files.length) break;
  }
  return { files: all };
}

export async function sendMarkdown(receiveId, md, creds, opts = {}) {
  const receiveIdType = opts.receiveIdType || 'open_id';
  const cardTitle = opts.title || 'Acaily';
  const token = await getTenantToken(creds);
  if (!token) return { skipped: true, reason: '未配置飞书凭据' };

  let content = (md || '').trim();
  // 超长：直接回退纯文本，避免卡片超限
  if (content.length > CARD_MD_LIMIT) {
    return sendText(receiveId, stripMarkdown(content), creds, { receiveIdType });
  }

  // 卡片 markdown 不支持 # 标题，先转成加粗
  const cardContent = cardMarkdown(content);

  const card = {
    config: { streaming_mode: false },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: cardTitle },
    },
    elements: [{ tag: 'markdown', content: cardContent }],
  };

  const res = await fetch(`${FEISHU_HOST}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    // 卡片失败（权限/格式）→ 回退纯文本
    console.warn('[feishu] 卡片发送失败，回退文本:', data.msg);
    return sendText(receiveId, stripMarkdown(content), creds, { receiveIdType });
  }
  return { ok: true, messageId: data.data?.message_id, card: true };
}
