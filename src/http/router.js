// 请求入口模块：路由、参数解析、错误映射。
// 不做状态计算（domain/lab）和记录存储（store/repository），只负责转发。

import * as lab from "../domain/lab.js";

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new lab.LabError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

export function createRouter({ repo, page }) {
  // 所有变更走串行事务，成功落库后返回重算后的原片
  async function mutate(res, status, mutator) {
    const master = await repo.transact(mutator);
    sendJson(res, status, lab.presentMaster(master));
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;

      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page);
      }
      if (req.method === "GET" && path === "/api/samples") {
        const db = await repo.read();
        return sendJson(res, 200, db.samples.map(lab.presentMaster));
      }
      if (req.method === "POST" && path === "/api/samples") {
        const input = await readBody(req);
        return await mutate(res, 201, db => lab.createMaster(db, input, lab.nextMasterId(db)));
      }
      const trace = path.match(/^\/api\/samples\/([^/]+)\/trace$/);
      if (req.method === "GET" && trace) {
        const db = await repo.read();
        const master = lab.findMaster(db, decodeURIComponent(trace[1]));
        return sendJson(res, 200, { master: lab.presentMaster(master), records: master.records, events: master.events });
      }
      const derive = path.match(/^\/api\/samples\/([^/]+)\/slices$/);
      if (req.method === "POST" && derive) {
        const input = await readBody(req);
        const masterId = decodeURIComponent(derive[1]);
        return await mutate(res, 201, db => lab.deriveSlice(db, masterId, input));
      }
      const step = path.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/steps$/);
      if (req.method === "POST" && step) {
        const input = await readBody(req);
        const masterId = decodeURIComponent(step[1]);
        const sliceId = decodeURIComponent(step[2]);
        return await mutate(res, 200, db => lab.recordStep(db, masterId, sliceId, input));
      }
      const deliver = path.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/deliver$/);
      if (req.method === "POST" && deliver) {
        const masterId = decodeURIComponent(deliver[1]);
        const sliceId = decodeURIComponent(deliver[2]);
        return await mutate(res, 200, db => lab.deliverSlice(db, masterId, sliceId));
      }
      const review = path.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/review$/);
      if (req.method === "POST" && review) {
        const input = await readBody(req);
        const masterId = decodeURIComponent(review[1]);
        const sliceId = decodeURIComponent(review[2]);
        return await mutate(res, 200, db => lab.reviewSlice(db, masterId, sliceId, input.decision));
      }
      const contaminate = path.match(/^\/api\/samples\/([^/]+)\/contaminate$/);
      if (req.method === "POST" && contaminate) {
        const masterId = decodeURIComponent(contaminate[1]);
        return await mutate(res, 200, db => lab.contaminate(db, masterId));
      }
      const release = path.match(/^\/api\/samples\/([^/]+)\/release$/);
      if (req.method === "POST" && release) {
        const masterId = decodeURIComponent(release[1]);
        return await mutate(res, 200, db => lab.releaseQuarantine(db, masterId));
      }
      return sendJson(res, 404, { error: "not_found", message: "接口不存在" });
    } catch (error) {
      if (error instanceof lab.LabError) {
        return sendJson(res, error.status, { error: error.code, message: error.message });
      }
      return sendJson(res, 500, { error: "internal_error", message: error.message });
    }
  };
}
