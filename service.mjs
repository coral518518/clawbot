// 服务声明：向 Prisma Compute 描述本服务的构建产物、输入与端口。
// 这是部署与 dev 使用的唯一权威声明（module.mjs 与构建产物均引用本文件）。
import node from "@prisma/composer/node";
import { compute } from "@prisma/composer-prisma-cloud";
import { type } from "arktype";
import { secretString } from "@prisma/composer/arktype";

export default compute({
  name: "notifier",
  deps: {},
  // 外部调用 /api/send 与管理接口所需的固定密钥（仅用户持有，module.mjs 以 envSecret 绑定）
  input: type({ apiKey: secretString() }),
  build: node({
    module: import.meta.url,
    // 构建产物目录（npm run build 生成），整个目录随部署原样交付
    dir: "dist",
    entry: "server.js",
    // 构建不打包依赖，部署时从 node_modules 追踪并随产物一起交付
    dependencies: "external",
  }),
});
