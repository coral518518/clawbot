import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const AUTH_FILE = path.join(config.dataDir, 'auth_state.json');
const changeListeners = new Set();

// 确保存储目录存在
function ensureDirExists() {
  try {
    if (!fs.existsSync(config.dataDir)) {
      fs.mkdirSync(config.dataDir, { recursive: true });
    }
  } catch (err) {
    console.error('[Storage] 创建存储目录失败:', err.message);
  }
}

ensureDirExists();

export const storage = {
  // 订阅存储变更（用于集群间状态同步）
  subscribe(fn) {
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
  },

  get() {
    try {
      if (!fs.existsSync(AUTH_FILE)) return null;
      const raw = fs.readFileSync(AUTH_FILE, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      console.error('[Storage] 读取鉴权文件失败:', err.message);
      return null;
    }
  },

  set(data, broadcast = true) {
    ensureDirExists();
    const tempPath = `${AUTH_FILE}.tmp.${Date.now()}`;
    // 自动维护更新时间戳：本地发起的变更 (broadcast=true) 必须强制刷新为当前时间戳，确保集群能感知到最新版本
    if (data && typeof data === 'object') {
      if (broadcast) {
        data.updatedAt = Date.now();
      } else {
        data.updatedAt = Number(data.updatedAt) || Date.now();
      }
    }
    const payload = JSON.stringify(data, null, 2);

    try {
      // 临时文件写入 + 原子替换，防止写入中途断电导致文件损坏
      fs.writeFileSync(tempPath, payload, 'utf-8');
      try {
        fs.renameSync(tempPath, AUTH_FILE);
      } catch {
        // Windows 或特定文件系统锁定时 fallback
        fs.copyFileSync(tempPath, AUTH_FILE);
        try { fs.unlinkSync(tempPath); } catch {}
      }
    } catch (err) {
      console.error('[Storage] 保存鉴权文件失败，尝试直接写入:', err.message);
      try {
        fs.writeFileSync(AUTH_FILE, payload, 'utf-8');
      } catch (directErr) {
        console.error('[Storage] 直接写入鉴权文件亦失败:', directErr.message);
      }
    }

    // 触发集群状态变更广播
    if (broadcast) {
      for (const listener of changeListeners) {
        try { listener(data); } catch (e) {
          console.error('[Storage] 集群状态监听器执行异常:', e.message);
        }
      }
    }
  },

  clear(broadcast = true) {
    try {
      if (fs.existsSync(AUTH_FILE)) {
        fs.unlinkSync(AUTH_FILE);
      }
    } catch (err) {
      console.error('[Storage] 删除鉴权文件失败:', err.message);
    }
    if (broadcast) {
      for (const listener of changeListeners) {
        try { listener(null); } catch (e) {}
      }
    }
  }
};
