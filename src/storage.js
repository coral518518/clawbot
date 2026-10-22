import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const AUTH_FILE = path.join(config.dataDir, 'auth_state.json');

// 确保目录存在
if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

export const storage = {
  get() {
    try {
      if (!fs.existsSync(AUTH_FILE)) return null;
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    } catch (err) {
      console.error('[Storage] 读取鉴权文件失败:', err.message);
      return null;
    }
  },

  set(data) {
    try {
      // 临时文件写入 + 原子重命名，防止写入中途断电导致文件损坏
      const tempPath = `${AUTH_FILE}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tempPath, AUTH_FILE);
    } catch (err) {
      console.error('[Storage] 保存鉴权文件失败:', err.message);
    }
  },

  clear() {
    if (fs.existsSync(AUTH_FILE)) {
      fs.unlinkSync(AUTH_FILE);
    }
  }
};
