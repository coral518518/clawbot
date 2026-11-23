// 构建：生成 dist/ 部署产物目录。
// dist/ = 应用源码（src/，含运行时读取的 admin.html）+ 服务声明 service.mjs
//         （应用代码导入它读取输入与端口，因此必须随产物一起交付）。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, 'src');
const serviceFile = path.join(root, 'service.mjs');
const outDir = path.join(root, 'dist');

fs.rmSync(outDir, { recursive: true, force: true });

// 复制应用源码；service.mjs 以根目录的权威声明为准（src/ 内是转发 shim，勿带出）
fs.cpSync(srcDir, outDir, {
  recursive: true,
  filter: (source) => path.basename(source) !== 'service.mjs',
});
fs.copyFileSync(serviceFile, path.join(outDir, 'service.mjs'));

// 产物内无上层 package.json 可依赖，显式声明 ESM
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2) + '\n');

console.log('[build] 已生成 dist/（应用源码 + service.mjs + package.json）');
