// @ts-nocheck
import { getUserAccessToken } from '../config/userConfigStore.js';
import { listDriveFiles, moveDriveFile, copyDriveFile, listDriveFilesAll, downloadDriveFile } from '../feishu/client.js';

// 列出飞书云盘某文件夹下的文件
export const listDriveFilesTool = {
  name: 'list_drive_files',
  description:
    '列出飞书云盘某个文件夹下的文件和子文件夹。当用户要查看/整理云盘文件、按学生名匹配文件时使用。参数：{"folder_token":"文件夹 token（取自云盘链接 https://<域名>.feishu.cn/drive/folder/<token> 中 /folder/ 之后的那段）"}。返回文件清单（名称 + file_token + 类型）。需要用户已授权云盘访问（若返回未授权提示，请让用户重新登录以授权）。',
  async run(args, context) {
    const folderToken = args && args.folder_token;
    if (!folderToken) return '错误：缺少 folder_token（云盘文件夹链接里 /folder/ 后的那段）';
    const userToken = await getUserAccessToken(context && context.openId);
    if (!userToken)
      return '错误：你尚未授权飞书云盘，无法读取文件夹。请退出登录后重新登录，并在授权页同意「云盘」权限，再试。';
    const r = await listDriveFiles({ folderToken, userAccessToken: userToken });
    if (r && r.error) return `列出云盘文件失败：${r.error}`;
    const files = (r && r.files) || [];
    if (!files.length) return `文件夹 ${folderToken} 下没有文件。`;
    return JSON.stringify(
      { count: files.length, files: files.map((f) => ({ name: f.name, file_token: f.file_token, type: f.type })) },
      null,
      2,
    );
  },
};

// 移动云盘文件到目标文件夹
export const moveDriveFileTool = {
  name: 'move_drive_file',
  description:
    '把飞书云盘里的一个文件移动到另一个文件夹。当用户要把匹配到的文件归类/移动到目标文件夹时使用。参数：{"file_token":"要移动的文件 token","dest_folder_token":"目标文件夹 token","type":"file（默认，也可传 folder）"}。需要用户已授权云盘访问。',
  async run(args, context) {
    const fileToken = args && args.file_token;
    const destFolderToken = args && args.dest_folder_token;
    if (!fileToken || !destFolderToken) return '错误：缺少 file_token 或 dest_folder_token';
    const userToken = await getUserAccessToken(context && context.openId);
    if (!userToken)
      return '错误：你尚未授权飞书云盘，无法移动文件。请退出登录后重新登录，并在授权页同意「云盘」权限，再试。';
    const r = await moveDriveFile({
      fileToken,
      destFolderToken,
      type: args.type === 'folder' ? 'folder' : 'file',
      userAccessToken: userToken,
    });
    if (r && r.error) return `移动文件失败：${r.error}`;
    return `已移动文件（${fileToken}）到文件夹（${destFolderToken}）。`;
  },
};

// 去除文件名扩展名（用于「完全同名」「文件夹名包含文件名」匹配）
function stripExt(name) {
  return (name || '').replace(/\.[^./\\]+$/, '');
}

// 从文件名/文件夹名里提取「姓名候选键」：
//  - 去扩展名的全名
//  - 开头的连续中文字符（如「白一凡」）
//  - 开头的「中文+英文字母」连续段（如「白一凡Leon」），停在常见分隔符（的 / - _ 【 ( 空格）之前
function nameKeys(name) {
  const base = stripExt(name);
  const keys = new Set();
  if (base) keys.add(base);
  // 取开头一段：以常见分隔符（的 / - _ 【 ( （ 空格）截断，如「白一凡的学习情况评价...」→「白一凡」
  // 这样「白一凡的学习情况评价」能匹配文件夹「白一凡Leon」（含「白一凡」）
  const front = base.split(/[-_ 【(（\s的]/)[0];
  if (front) keys.add(front);
  return Array.from(keys);
}

// 灵活中文名匹配：从源文件名提取姓名候选，只要某个候选是「同学文件夹名」的子串，即视为命中。
// 语义：文件名里出现的学生姓名（可能只有中文名）能被文件夹名（可能中英混合）包含即可。
// 例：文件「白一凡的学习情况评价...」→ 候选含「白一凡」；文件夹「白一凡Leon」包含「白一凡」→ 命中。
function cnFlexMatch(fileName, folderName) {
  const fk = nameKeys(fileName);
  for (const k of fk) {
    if (k && folderName.includes(k)) return true;
  }
  return false;
}

// 按匹配模式，从同学子文件夹里找出与文件名最匹配的那个（取最长匹配，避免「张三」误中「张三丰」）。
// mode: 'contains'(默认) 文件名包含同学名，或灵活中文名匹配 | 'exact' 完全同名(去扩展名) | 'folder_contains' 同学名包含文件名(去扩展名) | 'cn_flex' 仅做灵活中文名匹配
function matchStudentFolder(fileName, studentFolders, mode) {
  const base = stripExt(fileName);
  let best = null;
  for (const fld of studentFolders) {
    const sname = fld.name || '';
    let hit = false;
    if (mode === 'exact') hit = sname === base || sname === fileName;
    else if (mode === 'folder_contains') hit = !!base && sname.includes(base);
    else if (mode === 'cn_flex') hit = !!sname && cnFlexMatch(fileName, sname);
    else hit = !!sname && (fileName.includes(sname) || cnFlexMatch(fileName, sname)); // contains（默认），含中文灵活匹配
    if (hit && (!best || sname.length > best.name.length)) best = fld;
  }
  return best;
}

// 批量把「源文件夹」里的文件，按姓名匹配到「目标父文件夹」下对应的同学子文件夹后，复制或移动。
// 一次工具调用完成「列源 → 列目标子文件夹 → 按姓名匹配 → 逐个操作」，避免多步耗尽对话步数上限。
async function batchToStudentFolders(op, args, context) {
  const sourceFolderToken = args && args.source_folder_token;
  const targetParentFolderToken = args && args.target_parent_folder_token;
  const matchMode = (args && args.match_mode) || 'contains';
  // 复制时默认开启「内容一致则跳过」，避免重复运行产生一堆完全相同副本
  const skipIdentical = op === 'copy' ? (args && args.skip_if_identical !== false) : false;
  if (!sourceFolderToken || !targetParentFolderToken)
    return '错误：缺少 source_folder_token 或 target_parent_folder_token（均取自云盘链接 /folder/ 之后的那段）';
  const userToken = await getUserAccessToken(context && context.openId);
  if (!userToken)
    return '错误：你尚未授权飞书云盘，无法操作。请退出登录后重新登录，并在授权页同意「云盘」权限，再试。';

  // 1) 源文件夹里的文件（自动翻页）
  const src = await listDriveFilesAll({ folderToken: sourceFolderToken, userAccessToken: userToken });
  if (src && src.error) return `列出源文件夹失败：${src.error}`;
  const sourceFiles = ((src && src.files) || []).filter((f) => f.type === 'file');
  if (!sourceFiles.length) return `源文件夹 ${sourceFolderToken} 下没有文件可${op === 'copy' ? '复制' : '移动'}。`;

  // 2) 目标父文件夹下的同学子文件夹
  const tgt = await listDriveFilesAll({ folderToken: targetParentFolderToken, userAccessToken: userToken });
  if (tgt && tgt.error) return `列出目标文件夹失败：${tgt.error}`;
  const studentFolders = ((tgt && tgt.files) || []).filter((f) => f.type === 'folder');
  if (!studentFolders.length) return `目标文件夹 ${targetParentFolderToken} 下没有子文件夹（同学目录），无法匹配。`;

  // 目标子文件夹内容缓存（查重时避免重复拉取）
  const destCache = {};
  async function listFolderChildren(folderToken) {
    if (destCache[folderToken]) return destCache[folderToken];
    const r = await listDriveFilesAll({ folderToken, userAccessToken: userToken });
    const files = (r && r.files) || [];
    destCache[folderToken] = files;
    return files;
  }

  // 3) 匹配 + 操作：取最长匹配（避免「张三」误匹配「张三丰」）
  const done = [];
  const failed = [];
  const unmatched = [];
  const skipped = [];
  for (const file of sourceFiles) {
    const fname = file.name || '';
    const best = matchStudentFolder(fname, studentFolders, matchMode);
    if (!best) {
      unmatched.push({ name: fname, file_token: file.file_token });
      continue;
    }
    // 复制场景：若目标文件夹已存在同名文件且内容完全一致，则跳过（不重复复制）
    if (skipIdentical) {
      const children = await listFolderChildren(best.file_token);
      const existing = children.find((c) => c.type === 'file' && stripExt(c.name) === stripExt(fname));
      if (existing) {
        const srcDl = await downloadDriveFile({ fileToken: file.file_token, userAccessToken: userToken });
        const dstDl = await downloadDriveFile({ fileToken: existing.file_token, userAccessToken: userToken });
        if (srcDl && srcDl.ok && dstDl && dstDl.ok && srcDl.content.equals(dstDl.content)) {
          skipped.push({ name: fname, to: best.name, reason: '内容完全一致，已跳过' });
          continue;
        }
      }
    }
    const r =
      op === 'copy'
        ? await copyDriveFile({ fileToken: file.file_token, destFolderToken: best.file_token, name: fname, type: file.type, userAccessToken: userToken })
        : await moveDriveFile({ fileToken: file.file_token, destFolderToken: best.file_token, type: 'file', userAccessToken: userToken });
    if (r && r.error) failed.push({ name: fname, to: best.name, error: r.error });
    else done.push({ name: fname, to: best.name });
  }
  const key = op === 'copy' ? 'copied' : 'moved';
  const summary = { [key]: done.length, failed: failed.length, unmatched: unmatched.length, total: sourceFiles.length, match_mode: matchMode };
  if (op === 'copy') summary.skipped_identical = skipped.length;
  return JSON.stringify(
    {
      summary,
      [key]: done,
      failed,
      unmatched,
      ...(op === 'copy' ? { skipped } : {}),
    },
    null,
    2,
  );
}

const MATCH_MODE_DESC = 'match_mode 可选：contains(默认,文件名包含同学名，或源文件中文名被同学文件夹名包含即可，如「白一凡的学习情况评价」可匹配「白一凡Leon」) | exact(文件名去扩展名与同学名完全相同) | folder_contains(同学名包含文件名去扩展名) | cn_flex(仅做灵活中文名匹配)';

// 批量复制：保留源文件
export const copyDriveFilesToStudentFoldersTool = {
  name: 'copy_drive_files_to_student_folders',
  description:
    `批量归档：把某个「源文件夹」里的文件，按姓名匹配规则自动复制到「目标父文件夹」下以同学姓名命名的子文件夹中（保留源文件，是复制不是移动）。适用于把学生作业/资料按姓名分发给对应同学的文件夹。匹配规则宽松：源文件名即使只有中文名（如「白一凡的学习情况评价.md」）也能匹配到中英混合的同学文件夹（如「白一凡Leon」）。参数：{"source_folder_token":"源文件夹 token（待复制文件来源，取自链接 /folder/ 后那段）","target_parent_folder_token":"目标父文件夹 token（其下每个子文件夹是一个同学）",${MATCH_MODE_DESC},"skip_if_identical":"true(默认) 若目标文件夹已存在同名文件且内容完全一致则跳过不复制；false 则强制复制"}。返回结果（成功/跳过(内容一致)/未匹配/失败清单）。需要用户已授权云盘。`,
  run: (args, context) => batchToStudentFolders('copy', args, context),
};

// 批量移动：从源文件夹移走
export const moveDriveFilesToStudentFoldersTool = {
  name: 'move_drive_files_to_student_folders',
  description:
    `批量整理：把某个「源文件夹」里的文件，按姓名匹配规则自动移动到「目标父文件夹」下以同学姓名命名的子文件夹中（不保留源文件，是移动不是复制）。适用于把学生作业/资料按姓名归类到对应同学的文件夹。参数：{"source_folder_token":"源文件夹 token（待移动文件来源，取自链接 /folder/ 后那段）","target_parent_folder_token":"目标父文件夹 token（其下每个子文件夹是一个同学）",${MATCH_MODE_DESC}}。返回结果（成功/未匹配/失败清单）。需要用户已授权云盘。`,
  run: (args, context) => batchToStudentFolders('move', args, context),
};

export const feishuDriveTools = [
  listDriveFilesTool,
  moveDriveFileTool,
  copyDriveFilesToStudentFoldersTool,
  moveDriveFilesToStudentFoldersTool,
];
