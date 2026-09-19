// 请求入口模块：HTTP 路由、参数校验与页面输出，不直接实现状态规则或文件读写。
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRepository } from "./store/repository.js";
import { page } from "./ui/page.js";
import {
  DomainError,
  PARENT_STEPS,
  applyStepRecord,
  applyDerivedRecord,
  createDerived,
  deliverDerived,
  reviewDerived,
  contaminateSlice,
  releaseSlice,
  buildTrace,
  sliceIdExists,
  assertUsableId,
  nextRecordId,
  now
} from "./domain/status.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

function requireFields(input, fields) {
  for (const field of fields) {
    if (!input[field] || !String(input[field]).trim()) {
      throw new DomainError(400, "missing_field", `缺少必填字段：${field}`);
    }
  }
}

function findSample(db, id) {
  const sample = db.samples.find(item => item.id === id);
  if (!sample) throw new DomainError(404, "sample_not_found", "样本不存在");
  return sample;
}

function findSlice(sample, id) {
  const slice = (sample.slices || []).find(item => item.id === id);
  if (!slice) throw new DomainError(404, "slice_not_found", "原片不存在");
  return slice;
}

function findDerived(slice, id) {
  const derived = (slice.derived || []).find(item => item.id === id);
  if (!derived) throw new DomainError(404, "derived_not_found", "派生片不存在");
  return derived;
}

function newSlice(id, method, note) {
  return {
    id,
    method: method || "未指定",
    observation: "",
    status: "待切割",
    records: [{ id: nextRecordId(), at: now(), step: "取样", note, kind: "原始", valid: true }],
    derived: [],
    contamination: { status: "无", history: [] }
  };
}

export function createApp(repo) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page);
      }
      if (req.method === "GET" && url.pathname === "/api/samples") {
        const db = await repo.read();
        return sendJson(res, 200, db.samples);
      }
      if (req.method === "POST" && url.pathname === "/api/samples") {
        const input = await body(req);
        requireFields(input, ["project", "borehole", "coreBox", "depth", "owner", "sliceId", "method"]);
        assertUsableId(input.sliceId);
        const sample = await repo.update(db => {
          if (sliceIdExists(db, input.sliceId)) throw new DomainError(409, "duplicate_id", `编号 ${input.sliceId} 已存在`);
          const item = {
            id: `CORE-${Date.now()}`,
            project: input.project,
            borehole: input.borehole,
            coreBox: input.coreBox,
            depth: input.depth,
            owner: input.owner,
            status: "待切割",
            delivery: "未交付",
            slices: [newSlice(input.sliceId, input.method, "创建初始切片任务")]
          };
          db.samples.unshift(item);
          return item;
        });
        return sendJson(res, 201, sample);
      }
      const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
      if (addSlice && req.method === "POST") {
        const input = await body(req);
        requireFields(input, ["id"]);
        assertUsableId(input.id);
        const sample = await repo.update(db => {
          const item = findSample(db, decodeURIComponent(addSlice[1]));
          if (sliceIdExists(db, input.id)) throw new DomainError(409, "duplicate_id", `编号 ${input.id} 已存在`);
          item.slices.push(newSlice(input.id, input.method, "新增原片"));
          return item;
        });
        return sendJson(res, 201, sample);
      }
      const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
      if (logMatch && req.method === "POST") {
        const input = await body(req);
        requireFields(input, ["step"]);
        const sample = await repo.update(db => {
          const item = findSample(db, decodeURIComponent(logMatch[1]));
          const slice = findSlice(item, decodeURIComponent(logMatch[2]));
          if (slice.contamination.status === "隔离中") throw new DomainError(409, "slice_isolated", "原片污染隔离中，不能登记工序");
          applyStepRecord(slice, PARENT_STEPS, { step: input.step, note: input.note || "", correct: Boolean(input.correct) });
          if (input.step === "观察") slice.observation = input.note || slice.observation;
          return item;
        });
        return sendJson(res, 200, sample);
      }
      const deriveMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/derived$/);
      if (deriveMatch && req.method === "POST") {
        const input = await body(req);
        requireFields(input, ["id"]);
        assertUsableId(input.id);
        const derived = await repo.update(db => {
          const sample = findSample(db, decodeURIComponent(deriveMatch[1]));
          const slice = findSlice(sample, decodeURIComponent(deriveMatch[2]));
          if (sliceIdExists(db, input.id)) throw new DomainError(409, "duplicate_id", `编号 ${input.id} 已存在`);
          return createDerived(slice, input.id, input.note || "");
        });
        return sendJson(res, 201, derived);
      }
      const derivedRecord = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/derived\/([^/]+)\/records$/);
      if (derivedRecord && req.method === "POST") {
        const input = await body(req);
        requireFields(input, ["step"]);
        const sample = await repo.update(db => {
          const item = findSample(db, decodeURIComponent(derivedRecord[1]));
          const slice = findSlice(item, decodeURIComponent(derivedRecord[2]));
          applyDerivedRecord(findDerived(slice, decodeURIComponent(derivedRecord[3])), { step: input.step, note: input.note || "", correct: Boolean(input.correct) });
          return item;
        });
        return sendJson(res, 200, sample);
      }
      const derivedDeliver = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/derived\/([^/]+)\/deliver$/);
      if (derivedDeliver && req.method === "POST") {
        const sample = await repo.update(db => {
          const item = findSample(db, decodeURIComponent(derivedDeliver[1]));
          const slice = findSlice(item, decodeURIComponent(derivedDeliver[2]));
          deliverDerived(findDerived(slice, decodeURIComponent(derivedDeliver[3])));
          return item;
        });
        return sendJson(res, 200, sample);
      }
      const derivedReview = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/derived\/([^/]+)\/review$/);
      if (derivedReview && req.method === "POST") {
        const input = await body(req);
        const sample = await repo.update(db => {
          const item = findSample(db, decodeURIComponent(derivedReview[1]));
          const slice = findSlice(item, decodeURIComponent(derivedReview[2]));
          if (slice.contamination.status === "隔离中") throw new DomainError(409, "slice_isolated", "原片隔离未解除，不能复核派生片");
          reviewDerived(findDerived(slice, decodeURIComponent(derivedReview[3])), input.note || "");
          return item;
        });
        return sendJson(res, 200, sample);
      }
      const contaminate = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/contaminate$/);
      if (contaminate && req.method === "POST") {
        const input = await body(req);
        const sample = await repo.update(db => {
          const item = findSample(db, decodeURIComponent(contaminate[1]));
          contaminateSlice(findSlice(item, decodeURIComponent(contaminate[2])), input.note || "");
          return item;
        });
        return sendJson(res, 200, sample);
      }
      const release = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/release$/);
      if (release && req.method === "POST") {
        const input = await body(req);
        const sample = await repo.update(db => {
          const item = findSample(db, decodeURIComponent(release[1]));
          releaseSlice(findSlice(item, decodeURIComponent(release[2])), input.note || "");
          return item;
        });
        return sendJson(res, 200, sample);
      }
      const trace = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/trace$/);
      if (trace && req.method === "GET") {
        const db = await repo.read();
        const sample = findSample(db, decodeURIComponent(trace[1]));
        const slice = findSlice(sample, decodeURIComponent(trace[2]));
        return sendJson(res, 200, buildTrace(sample, slice));
      }
      const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
      if (deliverMatch && req.method === "POST") {
        const sample = await repo.update(db => {
          const item = findSample(db, decodeURIComponent(deliverMatch[1]));
          item.delivery = "已交付";
          return item;
        });
        return sendJson(res, 200, sample);
      }
      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof DomainError) return sendJson(res, error.status, { error: error.code, message: error.message });
      sendJson(res, 500, { error: "internal_error", message: error.message });
    }
  });
}

export function startServer(port = Number(process.env.PORT || 3025)) {
  const dbPath = process.env.DATA_FILE || join(__dirname, "..", "data", "core-slices.json");
  const server = createApp(createRepository(dbPath));
  server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
  return server;
}
