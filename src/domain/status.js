// 状态计算模块：纯函数领域逻辑，不依赖 HTTP 与存储。
// 覆盖工序记录（含更正与下游作废）、原片/派生片/样本状态重算、
// 污染隔离、冻结级联与逐张复核。

export const PARENT_STEPS = ["取样", "切割", "研磨", "染色", "观察"];
export const DERIVED_STEPS = ["切割", "研磨", "染色", "观察"];
export const SAMPLE_STATUSES = ["待切割", "制片中", "待观察", "已交付"];

export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
  }
}

export const now = () => new Date().toISOString();

let recordSeq = 0;
export function nextRecordId(prefix = "REC") {
  recordSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${recordSeq}`;
}

export function assertUsableId(id) {
  if (!id || !String(id).trim()) throw new DomainError(400, "missing_id", "编号不能为空");
  if (/[\s|/]/.test(id)) throw new DomainError(400, "invalid_id", "编号不能包含空白、竖线或斜杠");
}

// 派生片编号全局唯一：不得与任何原片或派生片编号重复。
export function sliceIdExists(db, id) {
  return (db.samples || []).some(sample =>
    (sample.slices || []).some(slice =>
      slice.id === id || (slice.derived || []).some(derived => derived.id === id)
    )
  );
}

export function validRecords(records) {
  return (records || []).filter(record => record.valid !== false);
}

export function validRecordFor(records, step) {
  return validRecords(records).find(record => record.step === step) || null;
}

export function pushEvent(target, type, note, at = now()) {
  const events = target.events || (target.events = []);
  events.push({ at, type, note: note || "" });
}

// 由有效工序记录推导状态：无有效记录为“待切割”，否则为已完成的最后工序。
export function computeStepStatus(records, steps) {
  let status = "待切割";
  let best = -1;
  for (const record of validRecords(records)) {
    const rank = steps.indexOf(record.step);
    if (rank > best) {
      best = rank;
      status = record.step;
    }
  }
  return status;
}

export function statusRank(status, steps) {
  return status === "待切割" ? -1 : steps.indexOf(status);
}

export function computeSampleStatus(sample) {
  if (sample.delivery === "已交付") return "已交付";
  const statuses = (sample.slices || []).map(slice => slice.status);
  if (statuses.length && statuses.every(status => status === "观察")) return "待观察";
  if (statuses.some(status => ["取样", "切割", "研磨", "染色"].includes(status))) return "制片中";
  return "待切割";
}

// 登记工序记录。同一工序只保留一条有效记录：
// - 普通登记：必须按工序顺序推进，同工序已有有效记录时冲突（并发重复提交只成功一次）；
// - 更正（correct=true）：替换同工序有效记录，并作废其全部下游工序记录。
export function applyStepRecord(target, steps, { step, note = "", correct = false }, at = now()) {
  if (!steps.includes(step)) throw new DomainError(400, "invalid_step", `未知工序：${step}`);
  const records = target.records || (target.records = []);
  const existing = validRecordFor(records, step);
  const record = { id: nextRecordId(), at, step, note, kind: correct ? "更正" : "原始", valid: true };
  if (correct) {
    if (!existing) throw new DomainError(409, "nothing_to_correct", `工序「${step}」没有有效记录可更正`);
    existing.valid = false;
    existing.supersededBy = record.id;
    existing.supersededAt = at;
    const rank = steps.indexOf(step);
    for (const item of validRecords(records)) {
      if (steps.indexOf(item.step) > rank) {
        item.valid = false;
        item.invalidatedBy = record.id;
        item.invalidatedAt = at;
        item.invalidateReason = `上游工序「${step}」更正`;
      }
    }
  } else {
    if (existing) throw new DomainError(409, "duplicate_step", `工序「${step}」已存在有效记录，如需修改请使用更正`);
    const nextStep = steps.find(item => !validRecordFor(records, item));
    if (step !== nextStep) {
      throw new DomainError(400, "step_out_of_order", nextStep ? `请按工序顺序登记，下一工序为「${nextStep}」` : "全部工序均已有有效记录，如需修改请使用更正");
    }
  }
  records.push(record);
  return record;
}

// 原片污染或状态回退时的级联：未交付派生片立即冻结，已交付派生片保留历史并标记受影响。
export function cascadeSlice(slice, reason, at = now()) {
  const changed = [];
  for (const derived of slice.derived || []) {
    if (derived.delivery === "已交付") {
      if (!derived.affected) {
        derived.affected = true;
        pushEvent(derived, "标记受影响", reason, at);
        changed.push(derived.id);
      }
    } else if (!derived.frozen) {
      derived.frozen = true;
      pushEvent(derived, "冻结", reason, at);
      changed.push(derived.id);
    }
  }
  return changed;
}

export function contaminateSlice(slice, note = "", at = now()) {
  const contamination = slice.contamination;
  if (contamination.status === "隔离中") throw new DomainError(409, "already_isolated", "原片已处于污染隔离中");
  contamination.status = "隔离中";
  contamination.history.push({ at, action: "标污染并隔离", note });
  return cascadeSlice(slice, `原片污染${note ? `：${note}` : ""}`, at);
}

// 解除隔离只放开原片本身，冻结派生片不自动恢复，需逐张复核。
export function releaseSlice(slice, note = "", at = now()) {
  const contamination = slice.contamination;
  if (contamination.status !== "隔离中") throw new DomainError(409, "not_isolated", "原片当前不在隔离中");
  contamination.status = "已解除";
  contamination.history.push({ at, action: "解除隔离", note });
}

export function reviewDerived(derived, note = "", at = now()) {
  if (!derived.frozen && !derived.affected) throw new DomainError(409, "not_frozen", "派生片未处于冻结或受影响状态");
  derived.frozen = false;
  derived.affected = false;
  pushEvent(derived, "复核恢复", note || "人工复核通过", at);
}

// 派生新切片：必须绑定有效（未隔离）原片，编号唯一性由调用方校验。
export function createDerived(slice, id, note = "", at = now()) {
  if (slice.contamination && slice.contamination.status === "隔离中") {
    throw new DomainError(409, "slice_isolated", "原片污染隔离中，未解除隔离不得继续派生");
  }
  const derived = {
    id,
    note,
    status: "待切割",
    delivery: "未交付",
    frozen: false,
    affected: false,
    observation: "",
    records: [],
    events: [{ at, type: "创建", note: note || `自原片 ${slice.id} 派生` }]
  };
  slice.derived.push(derived);
  return derived;
}

export function applyDerivedRecord(derived, input, at = now()) {
  if (derived.frozen) throw new DomainError(409, "derived_frozen", "派生片已冻结，需先复核恢复");
  if (derived.delivery === "已交付") throw new DomainError(409, "derived_delivered", "派生片已交付，保留历史记录，不能再登记工序");
  const record = applyStepRecord(derived, DERIVED_STEPS, input, at);
  if (input.step === "观察") derived.observation = input.note || derived.observation || "";
  derived.status = computeStepStatus(derived.records, DERIVED_STEPS);
  pushEvent(derived, input.correct ? "更正工序" : "登记工序", `${input.step}${input.note ? `：${input.note}` : ""}`, at);
  return record;
}

export function deliverDerived(derived, at = now()) {
  if (derived.frozen) throw new DomainError(409, "derived_frozen", "派生片已冻结，需先复核恢复");
  if (derived.delivery === "已交付") throw new DomainError(409, "already_delivered", "派生片已交付");
  if (derived.status !== "观察") throw new DomainError(400, "not_ready", "派生片需依次完成切割、研磨、染色、观察后才能交付");
  derived.delivery = "已交付";
  pushEvent(derived, "交付", "派生片已交付", at);
}

// 任一工序更正后重算原片与全部下游状态：原片状态回退立即级联冻结。
export function recomputeSample(sample, at = now()) {
  for (const slice of sample.slices || []) {
    const previous = slice.status || "待切割";
    const next = computeStepStatus(slice.records, PARENT_STEPS);
    slice.status = next;
    if (statusRank(next, PARENT_STEPS) < statusRank(previous, PARENT_STEPS)) {
      cascadeSlice(slice, `原片状态回退：${previous} → ${next}`, at);
    }
    if (slice.contamination && slice.contamination.status === "隔离中") {
      cascadeSlice(slice, "原片污染隔离中", at);
    }
    for (const derived of slice.derived || []) {
      derived.status = computeStepStatus(derived.records, DERIVED_STEPS);
    }
  }
  sample.status = computeSampleStatus(sample);
  return sample;
}

// 追溯视图：原片有效/作废记录、污染隔离历史、全部派生片状态与事件。
export function buildTrace(sample, slice) {
  return {
    sample: {
      id: sample.id,
      project: sample.project,
      borehole: sample.borehole,
      coreBox: sample.coreBox,
      depth: sample.depth,
      owner: sample.owner,
      status: sample.status,
      delivery: sample.delivery
    },
    slice: {
      id: slice.id,
      method: slice.method,
      status: slice.status,
      observation: slice.observation || "",
      contamination: slice.contamination
    },
    records: slice.records,
    derived: slice.derived
  };
}
