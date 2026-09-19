// 页面模板：样本列表、原片派生、工序登记/更正、污染隔离与追溯视图。
import { PARENT_STEPS, DERIVED_STEPS, SAMPLE_STATUSES } from "../domain/status.js";

export const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --warn:#8a3b3b; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } h3 { margin:12px 0 6px; font-size:15px; }
    main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
    button.danger { background:#a04848; }
    .stats { display:grid; grid-template-columns:repeat(6,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.warn { background:#f9ecec; border-color:#ddb3b3; color:var(--warn); }
    .slice { border-top:1px solid var(--line); padding-top:10px; display:grid; gap:8px; }
    .derived { border-left:3px solid var(--line); padding-left:10px; display:grid; gap:8px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; }
    .check { display:flex; align-items:center; gap:6px; margin:0; } .check input { width:auto; }
    #trace { margin-bottom:14px; } #trace ul { margin:6px 0; padding-left:20px; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">原片派生 · 工序更正 · 污染隔离与冻结复核</div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建岩芯样本</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" required>
      <label>负责人</label><input name="owner" required>
      <label>初始原片编号</label><input name="sliceId" required>
      <label>染色方法</label><input name="method" required>
      <button>保存样本</button>
    </form>
    <section>
      <div class="panel" id="trace" hidden></div>
      <div class="stats" id="stats"></div>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(SAMPLE_STATUSES)};
    const parentSteps = ${JSON.stringify(PARENT_STEPS)};
    const derivedSteps = ${JSON.stringify(DERIVED_STEPS)};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const traceEl = document.querySelector("#trace");
    let samples = [];

    function esc(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
      });
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? Object.assign({}, options, { headers: { "Content-Type": "application/json" } }) : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "请求失败");
      return data;
    }
    async function run(task) {
      try { await task(); } catch (error) { alert(error.message || "操作失败"); }
      await load();
    }
    function val(sel) { const el = document.querySelector(sel); return el ? el.value.trim() : ""; }
    function checked(sel) { const el = document.querySelector(sel); return !!(el && el.checked); }
    function pill(text, cls) { return '<span class="pill ' + (cls || "") + '">' + esc(text) + "</span>"; }
    function validStepsOf(records) { return (records || []).filter(function (r) { return r.valid !== false; }).map(function (r) { return r.step; }); }
    function optionsHtml(steps) { return steps.map(function (step) { return "<option>" + step + "</option>"; }).join(""); }

    function derivedHtml(sampleId, sliceId, derived) {
      const key = sampleId + "|" + sliceId + "|" + derived.id;
      let html = '<div class="derived"><div><b>' + esc(derived.id) + "</b> " + pill(derived.status) + " " + pill(derived.delivery);
      if (derived.frozen) html += " " + pill("已冻结", "warn");
      if (derived.affected) html += " " + pill("受影响", "warn");
      html += '</div><div class="meta">有效工序：' + esc(validStepsOf(derived.records).join(" → ") || "无") + (derived.observation ? " · 观察：" + esc(derived.observation) : "") + "</div>";
      html += '<select data-dstep="' + esc(key) + '">' + optionsHtml(derivedSteps) + "</select>";
      html += '<textarea data-dnote="' + esc(key) + '" placeholder="工序备注或观察结果"></textarea>';
      html += '<label class="check"><input type="checkbox" data-dcorrect="' + esc(key) + '"> 更正该工序（作废下游记录）</label>';
      html += '<div class="toolbar"><button data-dlog="' + esc(key) + '">登记工序</button><button class="ghost" data-ddeliver="' + esc(key) + '">交付派生片</button><button class="ghost" data-review="' + esc(key) + '">复核恢复</button></div>';
      if (derived.events && derived.events.length) html += '<div class="meta">' + derived.events.map(function (e) { return esc(e.type + (e.note ? "：" + e.note : "")); }).join(" / ") + "</div>";
      return html + "</div>";
    }

    function sliceHtml(sampleId, slice) {
      const key = sampleId + "|" + slice.id;
      let html = '<div class="slice"><div><b>' + esc(slice.id) + "</b> " + pill(slice.status);
      if (slice.contamination && slice.contamination.status === "隔离中") html += " " + pill("污染隔离中", "warn");
      if (slice.contamination && slice.contamination.status === "已解除") html += " " + pill("污染已解除", "warn");
      html += '</div><div class="meta">' + esc(slice.method) + " · 有效工序：" + esc(validStepsOf(slice.records).join(" → ") || "无") + (slice.observation ? " · 观察：" + esc(slice.observation) : "") + "</div>";
      html += '<select data-step="' + esc(key) + '">' + optionsHtml(parentSteps) + "</select>";
      html += '<textarea data-note="' + esc(key) + '" placeholder="工序备注或观察结果"></textarea>';
      html += '<label class="check"><input type="checkbox" data-correct="' + esc(key) + '"> 更正该工序（作废下游记录）</label>';
      html += '<div class="toolbar"><button data-log="' + esc(key) + '">登记工序</button><button class="danger" data-contaminate="' + esc(key) + '">标污染并隔离</button><button class="ghost" data-release="' + esc(key) + '">解除隔离</button><button class="ghost" data-trace="' + esc(key) + '">追溯</button></div>';
      html += '<div class="toolbar"><input data-derived-id="' + esc(key) + '" placeholder="派生片编号（全局唯一）"><button data-derive="' + esc(key) + '">派生切片</button></div>';
      html += (slice.derived || []).map(function (d) { return derivedHtml(sampleId, slice.id, d); }).join("");
      if (slice.records && slice.records.length) {
        html += '<div class="meta">记录：' + slice.records.map(function (r) {
          return esc(r.step + (r.kind === "更正" ? "（更正）" : "") + (r.valid === false ? "（作废）" : "") + (r.note ? "：" + r.note : ""));
        }).join(" / ") + "</div>";
      }
      return html + "</div>";
    }

    function sampleHtml(sample) {
      let html = '<article class="card"><h3>' + esc(sample.project) + "</h3><div>" + pill(sample.status) + " " + pill(sample.delivery) + "</div>";
      html += '<div class="meta">' + esc(sample.id) + " · " + esc(sample.borehole) + " · " + esc(sample.coreBox) + " · " + esc(sample.depth) + " · " + esc(sample.owner) + "</div>";
      html += '<div class="toolbar"><input data-new-slice="' + esc(sample.id) + '" placeholder="原片编号"><input data-method="' + esc(sample.id) + '" placeholder="染色方法"><button data-add="' + esc(sample.id) + '">添加原片</button></div>';
      html += (sample.slices || []).map(function (slice) { return sliceHtml(sample.id, slice); }).join("");
      html += '<div><button class="ghost" data-deliver="' + esc(sample.id) + '">标记样本交付</button></div></article>';
      return html;
    }

    function render() {
      const allSlices = samples.flatMap(function (s) { return s.slices; });
      const allDerived = allSlices.flatMap(function (s) { return s.derived; });
      const items = statuses.map(function (s) { return [s, samples.filter(function (item) { return item.status === s; }).length]; });
      items.push(["隔离原片", allSlices.filter(function (s) { return s.contamination && s.contamination.status === "隔离中"; }).length]);
      items.push(["冻结派生片", allDerived.filter(function (d) { return d.frozen; }).length]);
      stats.innerHTML = items.map(function (item) { return '<div class="stat"><span>' + item[0] + "</span><strong>" + item[1] + "</strong></div>"; }).join("");
      samplesEl.innerHTML = samples.map(sampleHtml).join("");
      bind();
    }

    function findSlice(sampleId, sliceId) {
      const sample = samples.find(function (s) { return s.id === sampleId; });
      return sample ? sample.slices.find(function (s) { return s.id === sliceId; }) : null;
    }

    function bind() {
      document.querySelectorAll("[data-step]").forEach(function (sel) {
        const parts = sel.dataset.step.split("|");
        const slice = findSlice(parts[0], parts[1]);
        if (!slice) return;
        const valid = validStepsOf(slice.records);
        sel.value = parentSteps.find(function (s) { return valid.indexOf(s) === -1; }) || "观察";
      });
      document.querySelectorAll("[data-dstep]").forEach(function (sel) {
        const parts = sel.dataset.dstep.split("|");
        const slice = findSlice(parts[0], parts[1]);
        const derived = slice && slice.derived.find(function (d) { return d.id === parts[2]; });
        if (!derived) return;
        const valid = validStepsOf(derived.records);
        sel.value = derivedSteps.find(function (s) { return valid.indexOf(s) === -1; }) || "观察";
      });
      document.querySelectorAll("[data-add]").forEach(function (btn) {
        btn.onclick = function () {
          run(async function () {
            const id = btn.dataset.add;
            await api("/api/samples/" + encodeURIComponent(id) + "/slices", { method: "POST", body: JSON.stringify({ id: val('[data-new-slice="' + id + '"]'), method: val('[data-method="' + id + '"]') || "未指定" }) });
          });
        };
      });
      document.querySelectorAll("[data-log]").forEach(function (btn) {
        btn.onclick = function () {
          run(async function () {
            const key = btn.dataset.log;
            const parts = key.split("|");
            await api("/api/samples/" + encodeURIComponent(parts[0]) + "/slices/" + encodeURIComponent(parts[1]) + "/logs", { method: "POST", body: JSON.stringify({ step: val('[data-step="' + key + '"]'), note: val('[data-note="' + key + '"]'), correct: checked('[data-correct="' + key + '"]') }) });
          });
        };
      });
      document.querySelectorAll("[data-derive]").forEach(function (btn) {
        btn.onclick = function () {
          run(async function () {
            const key = btn.dataset.derive;
            const parts = key.split("|");
            await api("/api/samples/" + encodeURIComponent(parts[0]) + "/slices/" + encodeURIComponent(parts[1]) + "/derived", { method: "POST", body: JSON.stringify({ id: val('[data-derived-id="' + key + '"]') }) });
          });
        };
      });
      document.querySelectorAll("[data-dlog]").forEach(function (btn) {
        btn.onclick = function () {
          run(async function () {
            const key = btn.dataset.dlog;
            const parts = key.split("|");
            await api("/api/samples/" + encodeURIComponent(parts[0]) + "/slices/" + encodeURIComponent(parts[1]) + "/derived/" + encodeURIComponent(parts[2]) + "/records", { method: "POST", body: JSON.stringify({ step: val('[data-dstep="' + key + '"]'), note: val('[data-dnote="' + key + '"]'), correct: checked('[data-dcorrect="' + key + '"]') }) });
          });
        };
      });
      document.querySelectorAll("[data-ddeliver]").forEach(function (btn) {
        btn.onclick = function () {
          run(async function () {
            const parts = btn.dataset.ddeliver.split("|");
            await api("/api/samples/" + encodeURIComponent(parts[0]) + "/slices/" + encodeURIComponent(parts[1]) + "/derived/" + encodeURIComponent(parts[2]) + "/deliver", { method: "POST", body: JSON.stringify({}) });
          });
        };
      });
      document.querySelectorAll("[data-review]").forEach(function (btn) {
        btn.onclick = function () {
          run(async function () {
            const parts = btn.dataset.review.split("|");
            await api("/api/samples/" + encodeURIComponent(parts[0]) + "/slices/" + encodeURIComponent(parts[1]) + "/derived/" + encodeURIComponent(parts[2]) + "/review", { method: "POST", body: JSON.stringify({}) });
          });
        };
      });
      document.querySelectorAll("[data-contaminate]").forEach(function (btn) {
        btn.onclick = function () {
          const note = prompt("污染说明（可选）", "");
          if (note === null) return;
          run(async function () {
            const parts = btn.dataset.contaminate.split("|");
            await api("/api/samples/" + encodeURIComponent(parts[0]) + "/slices/" + encodeURIComponent(parts[1]) + "/contaminate", { method: "POST", body: JSON.stringify({ note: note }) });
          });
        };
      });
      document.querySelectorAll("[data-release]").forEach(function (btn) {
        btn.onclick = function () {
          run(async function () {
            const parts = btn.dataset.release.split("|");
            await api("/api/samples/" + encodeURIComponent(parts[0]) + "/slices/" + encodeURIComponent(parts[1]) + "/release", { method: "POST", body: JSON.stringify({}) });
          });
        };
      });
      document.querySelectorAll("[data-trace]").forEach(function (btn) {
        btn.onclick = function () { showTrace(btn.dataset.trace); };
      });
      document.querySelectorAll("[data-deliver]").forEach(function (btn) {
        btn.onclick = function () {
          run(async function () {
            await api("/api/samples/" + encodeURIComponent(btn.dataset.deliver) + "/deliver", { method: "POST", body: JSON.stringify({}) });
          });
        };
      });
    }

    async function showTrace(key) {
      const parts = key.split("|");
      try {
        const trace = await api("/api/samples/" + encodeURIComponent(parts[0]) + "/slices/" + encodeURIComponent(parts[1]) + "/trace");
        renderTrace(trace);
      } catch (error) { alert(error.message || "查询失败"); }
    }
    function recordLine(r) {
      let text = r.at + " · " + r.step + " · " + r.kind + " · " + (r.valid === false ? "作废" : "有效");
      if (r.note) text += " · " + r.note;
      if (r.invalidateReason) text += " · " + r.invalidateReason;
      if (r.supersededBy) text += " · 被 " + r.supersededBy + " 取代";
      return "<li>" + esc(text) + "</li>";
    }
    function renderTrace(t) {
      let html = "<h2>追溯：" + esc(t.slice.id) + "（" + esc(t.sample.project) + "）</h2>";
      html += '<div class="meta">样本 ' + esc(t.sample.id) + " · " + esc(t.sample.borehole) + " · " + esc(t.sample.coreBox) + " · " + esc(t.sample.depth) + " · " + esc(t.sample.owner) + " · 样本状态 " + esc(t.sample.status) + " · " + esc(t.sample.delivery) + "</div>";
      html += '<div class="meta">原片状态 ' + esc(t.slice.status) + " · 污染状态 " + esc(t.slice.contamination.status) + " · " + esc(t.slice.method) + (t.slice.observation ? " · 观察：" + esc(t.slice.observation) : "") + "</div>";
      html += "<h3>原片工序记录</h3><ul>" + t.records.map(recordLine).join("") + "</ul>";
      html += "<h3>污染与隔离历史</h3><ul>" + (t.slice.contamination.history.length ? t.slice.contamination.history.map(function (h) { return "<li>" + esc(h.at + " · " + h.action + (h.note ? " · " + h.note : "")) + "</li>"; }).join("") : "<li>无</li>") + "</ul>";
      html += "<h3>派生片（" + t.derived.length + "）</h3>";
      if (!t.derived.length) html += '<div class="meta">暂无派生片</div>';
      t.derived.forEach(function (d) {
        html += '<div class="derived"><div><b>' + esc(d.id) + "</b> " + pill(d.status) + " " + pill(d.delivery) + (d.frozen ? " " + pill("已冻结", "warn") : "") + (d.affected ? " " + pill("受影响", "warn") : "") + "</div>";
        html += "<ul>" + d.records.map(recordLine).join("") + "</ul>";
        if (d.events && d.events.length) html += '<div class="meta">' + d.events.map(function (e) { return esc(e.at + " · " + e.type + (e.note ? " · " + e.note : "")); }).join(" / ") + "</div>";
        html += "</div>";
      });
      html += '<div class="toolbar" style="margin-top:10px"><button class="ghost" id="trace-close">关闭</button></div>';
      traceEl.innerHTML = html;
      traceEl.hidden = false;
      document.querySelector("#trace-close").onclick = function () { traceEl.hidden = true; };
      traceEl.scrollIntoView({ behavior: "smooth" });
    }

    async function load() { samples = await api("/api/samples"); render(); }
    document.querySelector("#reload").onclick = function () { load(); };
    form.onsubmit = function (event) {
      event.preventDefault();
      run(async function () {
        await api("/api/samples", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset();
      });
    };
    load();
  </script>
</body>
</html>`;
