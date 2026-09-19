// 领域模块：切片派生、工序流转、污染冻结与状态重算。
// 全部为纯函数：输入 db / 原片对象，就地修改后由存储模块统一持久化。

export const PIPELINE_STEPS = ["切割", "研磨", "染色", "观察"];
export const MASTER_STATUS_ORDER = ["待切割", "制片中", "待观察", "已交付"];
export const QUARANTINE_STATUS = "隔离中";
export const MASTER_STATUSES = [...MASTER_STATUS_ORDER, QUARANTINE_STATUS];

export class LabError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "LabError";
    this.status = status;
    this.code = code;
  }
}

const now = () => new Date().toISOString();

export function findMaster(db, masterId) {
  const master = db.samples.find(item => item.id === masterId);
  if (!master) throw new LabError(404, "master_not_found", "原片不存在");
  return master;
}

function findSlice(master, sliceId) {
  const slice = master.slices.find(item => item.id === sliceId);
  if (!slice) throw new LabError(404, "slice_not_found", "派生片不存在");
  return slice;
}

export function nextMasterId(db) {
  const base = `CORE-${Date.now()}`;
  if (!db.samples.some(sample => sample.id === base)) return base;
  let n = 2;
  while (db.samples.some(sample => sample.id === `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// ---- 状态计算（由记录推导，不落库，保证列表 / 追溯 / 刷新后一致）----

// 某张派生片当前有效的流水线工序记录
export function activeStepRecords(master, sliceId) {
  return master.records.filter(
    record => record.sliceId === sliceId && record.state === "有效" && PIPELINE_STEPS.includes(record.step)
  );
}

// 已依次完成的工序前缀（切割 → 研磨 → 染色 → 观察）
export function completedSteps(master, sliceId) {
  const done = new Set(activeStepRecords(master, sliceId).map(record => record.step));
  const steps = [];
  for (const step of PIPELINE_STEPS) {
    if (!done.has(step)) break;
    steps.push(step);
  }
  return steps;
}

export function computeSliceStatus(master, slice) {
  if (slice.scrapped) return "已报废";
  if (slice.delivery === "已交付") return "已交付";
  const done = completedSteps(master, slice.id);
  return done.length ? done[done.length - 1] : "待切割";
}

export function computeMasterStatus(master) {
  if (master.quarantined) return QUARANTINE_STATUS;
  const active = master.slices.filter(slice => !slice.scrapped);
  if (!active.length) return "待切割";
  const statuses = active.map(slice => computeSliceStatus(master, slice));
  if (statuses.every(status => status === "已交付")) return "已交付";
  if (statuses.every(status => status === "已交付" || status === "观察")) return "待观察";
  if (active.some(slice => completedSteps(master, slice.id).length > 0)) return "制片中";
  return "待切割";
}

// 列表 / 追溯共用的展示模型：状态全部由记录现算
export function presentMaster(master) {
  const slices = master.slices.map(slice => {
    const done = completedSteps(master, slice.id);
    const finished = slice.scrapped || slice.delivery === "已交付";
    const observation = activeStepRecords(master, slice.id).find(record => record.step === "观察");
    return {
      ...slice,
      status: computeSliceStatus(master, slice),
      completedSteps: done,
      nextStep: finished ? null : PIPELINE_STEPS[done.length] || null,
      observation: observation ? observation.note : "",
      records: master.records.filter(record => record.sliceId === slice.id),
    };
  });
  return { ...master, status: computeMasterStatus(master), slices };
}

// ---- 污染冻结闭环 ----

// 未交付派生片立即冻结；已交付保留历史并标记受影响
function freezeCascade(master, cause, at) {
  const frozen = [];
  const affected = [];
  for (const slice of master.slices) {
    if (slice.scrapped) continue;
    if (slice.delivery === "已交付") {
      if (!slice.affected) {
        slice.affected = true;
        affected.push(slice.id);
      }
    } else if (!slice.frozen) {
      slice.frozen = true;
      slice.frozenReason = cause;
      slice.frozenAt = at;
      frozen.push(slice.id);
    }
  }
  if (frozen.length || affected.length) {
    master.events.push({
      at,
      type: "污染冻结",
      detail: `${cause}：冻结未交付派生片 ${frozen.length ? frozen.join("、") : "无"}；已交付保留历史并标记受影响 ${affected.length ? affected.join("、") : "无"}`,
    });
  }
}

// 任一变更后重算原片状态；若状态回退则级联冻结全部下游
function recomputeAndCascade(master, previousStatus, at) {
  const nextStatus = computeMasterStatus(master);
  const prevRank = MASTER_STATUS_ORDER.indexOf(previousStatus);
  const nextRank = MASTER_STATUS_ORDER.indexOf(nextStatus);
  if (prevRank !== -1 && nextRank !== -1 && nextRank < prevRank) {
    master.events.push({ at, type: "状态回退", detail: `原片状态由「${previousStatus}」回退为「${nextStatus}」` });
    freezeCascade(master, "原片状态回退", at);
  }
  return nextStatus;
}

// ---- 业务动作 ----

export function createMaster(db, input, id, at = now()) {
  const fields = { project: "项目", borehole: "钻孔编号", coreBox: "岩芯箱号", depth: "取样深度", owner: "负责人" };
  for (const [key, label] of Object.entries(fields)) {
    if (!String(input[key] || "").trim()) throw new LabError(400, "missing_field", `缺少必填字段：${label}`);
  }
  const master = {
    id,
    project: String(input.project).trim(),
    borehole: String(input.borehole).trim(),
    coreBox: String(input.coreBox).trim(),
    depth: String(input.depth).trim(),
    owner: String(input.owner).trim(),
    contaminated: false,
    quarantined: false,
    slices: [],
    records: [],
    events: [{ at, type: "创建原片", detail: `登记原片 ${id}（${String(input.project).trim()}）` }],
  };
  db.samples.unshift(master);
  if (String(input.sliceId || "").trim()) {
    deriveSlice(db, master.id, { id: input.sliceId, method: input.method }, at);
  }
  return master;
}

export function deriveSlice(db, masterId, input, at = now()) {
  const master = findMaster(db, masterId);
  if (master.quarantined) throw new LabError(409, "master_quarantined", "原片未解除隔离，不得继续派生切片");
  const sliceId = String(input.id || "").trim();
  if (!sliceId) throw new LabError(400, "slice_id_required", "派生片必须绑定唯一编号");
  const duplicated = db.samples.some(sample => sample.slices.some(slice => slice.id === sliceId));
  if (duplicated) throw new LabError(409, "slice_id_taken", `编号 ${sliceId} 已被占用，派生片编号必须唯一`);
  const previousStatus = computeMasterStatus(master);
  master.slices.push({
    id: sliceId,
    method: String(input.method || "").trim() || "未指定",
    delivery: "未交付",
    deliveredAt: null,
    frozen: false,
    frozenReason: "",
    frozenAt: null,
    affected: false,
    scrapped: false,
    scrappedAt: null,
    createdAt: at,
  });
  master.events.push({ at, type: "派生切片", detail: `派生片 ${sliceId} 绑定原片 ${master.id}` });
  recomputeAndCascade(master, previousStatus, at);
  return master;
}

function appendRecord(master, sliceId, step, note, at, correction) {
  const seq = master.records.reduce((max, record) => Math.max(max, record.seq), 0) + 1;
  master.records.push({ seq, sliceId, step, note, at, state: "有效", correction });
}

export function recordStep(db, masterId, sliceId, input, at = now()) {
  const master = findMaster(db, masterId);
  const slice = findSlice(master, sliceId);
  if (master.quarantined) throw new LabError(409, "master_quarantined", "原片隔离中，派生片工序已冻结");
  if (slice.scrapped) throw new LabError(409, "slice_scrapped", "派生片已报废，不能再记录工序");
  if (slice.frozen) throw new LabError(409, "slice_frozen", "派生片已冻结，需逐张复核恢复后才能继续");
  if (slice.delivery === "已交付") throw new LabError(409, "slice_delivered", "派生片已交付，仅保留历史不可再记录");
  const step = String(input.step || "").trim();
  if (!PIPELINE_STEPS.includes(step)) throw new LabError(400, "unknown_step", `工序必须是：${PIPELINE_STEPS.join("、")}`);
  const note = String(input.note || "").trim();
  const correct = input.correct === true;
  const existing = activeStepRecords(master, sliceId).find(record => record.step === step);
  const previousStatus = computeMasterStatus(master);
  if (existing && !correct) {
    // 同一原片同一工序只保留一条有效记录：并发 / 重复提交只有第一次成功
    throw new LabError(409, "step_already_recorded", `同一原片同一工序只保留一条有效记录：${sliceId} 的「${step}」已存在，如需更正请显式提交`);
  }
  if (existing) {
    // 更正：作废本工序及全部下游有效记录，写入新记录后重算原片与下游状态
    const fromIndex = PIPELINE_STEPS.indexOf(step);
    let superseded = 0;
    for (const record of master.records) {
      if (record.sliceId !== sliceId || record.state !== "有效") continue;
      const index = PIPELINE_STEPS.indexOf(record.step);
      if (index !== -1 && index >= fromIndex) {
        record.state = "已更正";
        superseded += 1;
      }
    }
    appendRecord(master, sliceId, step, note, at, true);
    master.events.push({ at, type: "工序更正", detail: `${sliceId} 更正「${step}」，${superseded} 条有效记录作废，重算原片及下游状态` });
  } else {
    const done = completedSteps(master, sliceId);
    const expected = PIPELINE_STEPS[done.length];
    if (step !== expected) {
      throw new LabError(409, "step_out_of_order", `派生片需依次完成 ${PIPELINE_STEPS.join("、")}，当前应记录「${expected}」`);
    }
    appendRecord(master, sliceId, step, note, at, false);
    master.events.push({ at, type: "工序记录", detail: `${sliceId} 完成「${step}」${note ? `：${note}` : ""}` });
  }
  recomputeAndCascade(master, previousStatus, at);
  return master;
}

export function deliverSlice(db, masterId, sliceId, at = now()) {
  const master = findMaster(db, masterId);
  const slice = findSlice(master, sliceId);
  if (master.quarantined) throw new LabError(409, "master_quarantined", "原片隔离中，暂停交付");
  if (slice.scrapped) throw new LabError(409, "slice_scrapped", "派生片已报废");
  if (slice.frozen) throw new LabError(409, "slice_frozen", "派生片已冻结，复核恢复后才能交付");
  if (slice.delivery === "已交付") throw new LabError(409, "already_delivered", "派生片已交付，请勿重复交付");
  if (completedSteps(master, sliceId).length < PIPELINE_STEPS.length) {
    throw new LabError(409, "slice_not_ready", `需依次完成 ${PIPELINE_STEPS.join("、")} 后才能交付`);
  }
  const previousStatus = computeMasterStatus(master);
  slice.delivery = "已交付";
  slice.deliveredAt = at;
  master.events.push({ at, type: "交付", detail: `派生片 ${sliceId} 交付，历史记录保留` });
  recomputeAndCascade(master, previousStatus, at);
  return master;
}

export function contaminate(db, masterId, at = now()) {
  const master = findMaster(db, masterId);
  if (master.contaminated) throw new LabError(409, "already_contaminated", "原片已标记污染");
  master.contaminated = true;
  master.quarantined = true;
  master.events.push({ at, type: "污染标记", detail: "原片标记污染并转入隔离，未解除隔离前不得继续派生" });
  freezeCascade(master, "原片标记污染", at);
  return master;
}

export function releaseQuarantine(db, masterId, at = now()) {
  const master = findMaster(db, masterId);
  if (!master.quarantined) throw new LabError(409, "not_quarantined", "原片当前未处于隔离状态");
  master.quarantined = false;
  master.contaminated = false;
  // 冻结派生片不自动恢复，需逐张复核
  master.events.push({ at, type: "解除隔离", detail: "隔离解除，可继续派生；冻结派生片不自动恢复，需逐张复核" });
  return master;
}

export function reviewSlice(db, masterId, sliceId, decision, at = now()) {
  const master = findMaster(db, masterId);
  const slice = findSlice(master, sliceId);
  if (master.quarantined) throw new LabError(409, "master_quarantined", "解除隔离后才能逐张复核冻结片");
  if (!slice.frozen) throw new LabError(409, "slice_not_frozen", "仅冻结中的派生片需要复核");
  const previousStatus = computeMasterStatus(master);
  if (decision === "恢复") {
    slice.frozen = false;
    slice.frozenReason = "";
    slice.frozenAt = null;
    master.events.push({ at, type: "复核恢复", detail: `派生片 ${sliceId} 复核通过，恢复流转` });
  } else if (decision === "报废") {
    slice.frozen = false;
    slice.scrapped = true;
    slice.scrappedAt = at;
    master.events.push({ at, type: "复核报废", detail: `派生片 ${sliceId} 复核后报废，退出状态统计` });
  } else {
    throw new LabError(400, "invalid_decision", "复核结论必须是「恢复」或「报废」");
  }
  recomputeAndCascade(master, previousStatus, at);
  return master;
}
