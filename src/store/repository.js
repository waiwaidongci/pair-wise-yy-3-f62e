// 记录存储模块：JSON 库加载、保存、旧数据迁移与串行化写入。
// 所有读写经同一队列串行执行，重复检查与落盘在同一临界区内完成，
// 保证同一原片同一工序的并发提交只成功一次。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { recomputeSample } from "../domain/status.js";

export const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      slices: [
        {
          id: "SL-001-A",
          method: "茜素红染色",
          observation: "",
          status: "切割",
          records: [
            { id: "REC-SEED-1", at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置", kind: "原始", valid: true },
            { id: "REC-SEED-2", at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切", kind: "原始", valid: true }
          ],
          derived: [],
          contamination: { status: "无", history: [] }
        }
      ]
    }
  ]
};

function migrateDerived(derived) {
  derived.records = Array.isArray(derived.records) ? derived.records : [];
  derived.events = Array.isArray(derived.events) ? derived.events : [];
  derived.delivery = derived.delivery || "未交付";
  derived.frozen = Boolean(derived.frozen);
  derived.affected = Boolean(derived.affected);
  derived.observation = derived.observation || "";
  derived.note = derived.note || "";
}

function migrateSlice(slice, sampleIndex, sliceIndex) {
  if (!Array.isArray(slice.records)) {
    // 旧版 logs → 工序记录；同一工序只保留最后一条为有效记录
    const logs = Array.isArray(slice.logs) ? slice.logs : [];
    const records = logs.map((log, index) => ({
      id: `REC-M${sampleIndex}-${sliceIndex}-${index}`,
      at: log.at || new Date().toISOString(),
      step: log.step,
      note: log.note || "",
      kind: "原始",
      valid: true
    }));
    const lastIndexByStep = new Map();
    records.forEach((record, index) => lastIndexByStep.set(record.step, index));
    records.forEach((record, index) => {
      if (lastIndexByStep.get(record.step) !== index) {
        record.valid = false;
        record.invalidateReason = "迁移时同工序存在更新记录";
      }
    });
    slice.records = records;
  }
  delete slice.logs;
  slice.method = slice.method || "未指定";
  slice.observation = slice.observation || "";
  slice.derived = Array.isArray(slice.derived) ? slice.derived : [];
  slice.derived.forEach(migrateDerived);
  const contamination = slice.contamination && typeof slice.contamination === "object" ? slice.contamination : {};
  slice.contamination = {
    status: ["隔离中", "已解除"].includes(contamination.status) ? contamination.status : "无",
    history: Array.isArray(contamination.history) ? contamination.history : []
  };
}

// 载入时统一迁移旧结构并重算状态，保证列表、追溯与刷新后状态一致。
export function migrateDb(db) {
  const migrated = { samples: Array.isArray(db && db.samples) ? db.samples : [] };
  migrated.samples.forEach((sample, sampleIndex) => {
    sample.delivery = sample.delivery || "未交付";
    sample.slices = Array.isArray(sample.slices) ? sample.slices : [];
    sample.slices.forEach((slice, sliceIndex) => migrateSlice(slice, sampleIndex, sliceIndex));
    recomputeSample(sample);
  });
  return migrated;
}

export function createRepository(dbPath) {
  let queue = Promise.resolve();

  function enqueue(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  async function load() {
    if (!existsSync(dbPath)) {
      await mkdir(dirname(dbPath), { recursive: true });
      await writeFile(dbPath, JSON.stringify(seed, null, 2));
    }
    return migrateDb(JSON.parse(await readFile(dbPath, "utf8")));
  }

  async function save(db) {
    await writeFile(dbPath, JSON.stringify(db, null, 2));
  }

  return {
    read: () => enqueue(load),
    update(mutator) {
      return enqueue(async () => {
        const db = await load();
        const result = await mutator(db);
        for (const sample of db.samples) recomputeSample(sample);
        await save(db);
        return result;
      });
    }
  };
}
