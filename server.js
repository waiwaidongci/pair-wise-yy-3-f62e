// 启动入口：仅负责装配模块并监听端口（npm start 方式不变）。
// 请求入口：src/http/router.js；状态计算：src/domain/lab.js；记录存储：src/store/repository.js。

import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRepository } from "./src/store/repository.js";
import { createRouter } from "./src/http/router.js";
import { page } from "./src/http/page.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3025);
const dbPath = process.env.DB_PATH || join(__dirname, "data", "core-slices.json");

const repo = createRepository({ dbPath });
const server = http.createServer(createRouter({ repo, page }));

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
