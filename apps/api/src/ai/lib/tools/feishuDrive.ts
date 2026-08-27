// @ts-nocheck
import { getUserAccessToken } from '../config/userConfigStore.js';
import { listDriveFiles, moveDriveFile } from '../feishu/client.js';

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

export const feishuDriveTools = [listDriveFilesTool, moveDriveFileTool];
