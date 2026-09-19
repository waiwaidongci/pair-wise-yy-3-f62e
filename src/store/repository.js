// 记录存储模块：JSON 台账持久化、旧版数据迁移、串行事务。
// 所有写操作经 transact 串行执行（load → mutate → save 原子完成），
// 因此同一原片同一工序的并发提交只有第一笔能落库成功。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { PIPELINE_STEPS } from "../domain/lab.js";

export const SCHEMA_VERSION = 2;

export const seed = {
  schemaVersion: SCHEMA_VERSION,
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      contaminated: false,
      quarantined: false,
      slices: [
        {
          id: "SL-001-A",
          method: "茜素红染色",
          delivery: "未交付",
          deliveredAt: null,
          frozen: false,
          frozenReason: "",
          frozenAt: null,
          affected: false,
          scrapped: false,
          scrappedAt: null,
          createdAt: "2026-06-12T10:00:00.000Z",
        },
      ],
      records: [
        { seq: 1, sliceId: "SL-001-A", step: "取样", note: "截取含矿化条带位置", at: "2026-06-12T10:00:00.000Z", state: "有效", correction: false },
        { seq: 2, sliceId: "SL-001-A", step: "切割", note: "完成粗切", at: "2026-06-13T11:20:00.000Z", state: "有效", correction: false },
      ],
      events: [
        { at: "2026-06-12T10:00:00.000Z", type: "创建原片", detail: "登记原片 CORE-001（东岭铜矿薄片）" },
        { at: "2026-06-12T10:00:00.000Z", type: "派生切片", detail: "派生片 SL-001-A 绑定原片 CORE-001" },
      ],
    },
  ],
};

// v1（样本 + 切片内嵌 logs）→ v2（原片 + 派生片 + 工序台账）
function migrate(raw) {
  const samples = Array.isArray(raw.samples) ? raw.samples : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    samples: samples.map(sample => {
      const records = [];
      let seq = 0;
      for (const slice of sample.slices || []) {
        for (const log of slice.logs || []) {
          records.push({
            seq: ++seq,
            sliceId: slice.id,
            step: log.step,
            note: log.note || "",
            at: log.at || new Date().toISOString(),
            state: "有效",
            correction: false,
          });
        }
      }
      // 同一原片同一工序只保留一条有效记录：旧数据如有重复，以最后一条为准
      const seen = new Set();
      for (let i = records.length - 1; i >= 0; i -= 1) {
        const record = records[i];
        if (!PIPELINE_STEPS.includes(record.step)) continue;
        const key = `${record.sliceId}|${record.step}`;
        if (seen.has(key)) record.state = "已更正";
        else seen.add(key);
      }
      const delivered = sample.delivery === "已交付";
      const migratedAt = new Date().toISOString();
      return {
        id: sample.id,
        project: sample.project || "",
        borehole: sample.borehole || "",
        coreBox: sample.coreBox || "",
        depth: sample.depth || "",
        owner: sample.owner || "",
        contaminated: false,
        quarantined: false,
        slices: (sample.slices || []).map(slice => ({
          id: slice.id,
          method: slice.method || "未指定",
          delivery: delivered ? "已交付" : "未交付",
          deliveredAt: delivered ? migratedAt : null,
          frozen: false,
          frozenReason: "",
          frozenAt: null,
          affected: false,
          scrapped: false,
          scrappedAt: null,
          createdAt: (slice.logs && slice.logs[0] && slice.logs[0].at) || migratedAt,
        })),
        records,
        events: [{ at: migratedAt, type: "数据迁移", detail: "由旧版样本记录升级为派生 / 冻结模型" }],
      };
    }),
  };
}

export function createRepository({ dbPath, seedData = seed }) {
  let chain = Promise.resolve();

  function enqueue(job) {
    const result = chain.then(job);
    chain = result.then(() => undefined, () => undefined);
    return result;
  }

  async function persist(db) {
    const tmp = `${dbPath}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, dbPath);
  }

  async function loadFromDisk() {
    if (!existsSync(dbPath)) {
      await mkdir(dirname(dbPath), { recursive: true });
      const fresh = structuredClone(seedData);
      await persist(fresh);
      return fresh;
    }
    const raw = JSON.parse(await readFile(dbPath, "utf8"));
    if (raw.schemaVersion !== SCHEMA_VERSION) {
      const migrated = migrate(raw);
      await persist(migrated);
      return migrated;
    }
    return raw;
  }

  return {
    // 读取也排队，保证刷新后看到的是最近一次已落库的状态
    read: () => enqueue(loadFromDisk),
    // 串行事务：同一时刻只有一笔变更在检查并写库
    transact: mutator => enqueue(async () => {
      const db = await loadFromDisk();
      const result = await mutator(db);
      await persist(db);
      return result;
    }),
  };
}
