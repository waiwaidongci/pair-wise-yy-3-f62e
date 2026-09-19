// 页面模块：单页视图。状态全部由服务端重算后下发，刷新 / 列表 / 追溯一致。

import { MASTER_STATUSES, PIPELINE_STEPS } from "../domain/lab.js";

export const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --danger:#a33c31; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; }
    main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; }
    h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; } h4 { margin:12px 0 6px; font-size:14px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
    button.danger { background:var(--danger); }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; }
    .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .badge { display:inline-block; border-radius:4px; padding:2px 7px; font-size:12px; margin-left:6px; }
    .badge.frozen { background:#fdf0ef; color:var(--danger); border:1px solid #ecc7c2; }
    .badge.affected { background:#fdf6e6; color:#8a6d1a; border:1px solid #ead9a8; }
    .badge.quarantine { background:#efe9f7; color:#5b3f8c; border:1px solid #d5c8ec; }
    .badge.scrap { background:#eceeec; color:#666; border:1px solid #d7ddd1; }
    .slice { border-top:1px solid var(--line); padding-top:10px; display:grid; gap:7px; }
    .slice.frozen { background:#fbf7f6; border-radius:6px; padding:10px; }
    .slice-head { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
    .row { display:flex; gap:8px; } .row > * { flex:1 1 auto; }
    .derive { border:1px dashed var(--line); border-radius:6px; padding:10px; display:grid; gap:8px; }
    .derive label { margin:0; }
    .trace { border-top:1px solid var(--line); padding-top:8px; }
    .trace table { width:100%; border-collapse:collapse; font-size:12px; }
    .trace th,.trace td { border-bottom:1px solid var(--line); padding:5px 6px; text-align:left; }
    .strike { text-decoration:line-through; color:var(--muted); }
    .events { font-size:12px; color:var(--muted); display:grid; gap:4px; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>岩芯样本切片实验室</h1><div class="meta">原片派生 · 工序流水 · 污染冻结 · 复核追溯</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <form id="form">
      <h2>登记原片</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" required>
      <label>负责人</label><input name="owner" required>
      <label>首张派生片编号（可留空）</label><input name="sliceId">
      <label>染色方法</label><input name="method">
      <button>保存原片</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <script>
    const MASTER_STATUSES = ${JSON.stringify(MASTER_STATUSES)};
    const PIPELINE = ${JSON.stringify(PIPELINE_STEPS)};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    let samples = [];
    const traceOpen = {};

    async function api(path, options) {
      const opts = options && options.body ? Object.assign({}, options, { headers: { "Content-Type": "application/json" } }) : options;
      const res = await fetch(path, opts);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "请求失败");
      return data;
    }
    function esc(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
      });
    }
    function fmtTime(t) {
      if (!t) return "";
      const d = new Date(t);
      return isNaN(d.getTime()) ? String(t) : d.toLocaleString("zh-CN", { hour12: false });
    }

    function render() {
      stats.innerHTML = MASTER_STATUSES.map(function (s) {
        return '<div class="stat"><span>' + s + '</span><strong>' + samples.filter(function (m) { return m.status === s; }).length + '</strong></div>';
      }).join("");
      samplesEl.innerHTML = samples.map(renderMaster).join("") || '<div class="panel meta">暂无原片，请先登记</div>';
    }

    function renderMaster(m) {
      let html = '<article class="card">';
      html += '<div class="slice-head"><h3>' + esc(m.project) + '</h3><span>';
      html += '<span class="pill">' + esc(m.status) + '</span>';
      if (m.quarantined) html += '<span class="badge quarantine">隔离中</span>';
      if (m.contaminated) html += '<span class="badge frozen">污染</span>';
      html += '</span></div>';
      html += '<div class="meta">' + esc(m.id) + ' · ' + esc(m.borehole) + ' · ' + esc(m.coreBox) + ' · ' + esc(m.depth) + ' · 负责人 ' + esc(m.owner) + '</div>';
      html += '<div class="derive"><label>派生新切片（编号全局唯一）</label>';
      html += '<div class="row"><input class="new-slice" placeholder="切片编号"' + (m.quarantined ? ' disabled' : '') + '><input class="new-method" placeholder="染色方法"' + (m.quarantined ? ' disabled' : '') + '></div>';
      html += '<button data-act="derive" data-master="' + esc(m.id) + '"' + (m.quarantined ? ' disabled' : '') + '>派生切片</button>';
      if (m.quarantined) html += '<div class="meta">原片未解除隔离，不得继续派生</div>';
      html += '</div>';
      html += m.slices.map(function (s) { return renderSlice(m, s); }).join("");
      html += '<div class="row">';
      if (m.quarantined) html += '<button data-act="release" data-master="' + esc(m.id) + '">解除隔离</button>';
      else html += '<button class="danger" data-act="contaminate" data-master="' + esc(m.id) + '">标记污染</button>';
      html += '<button class="ghost" data-act="trace" data-master="' + esc(m.id) + '">' + (traceOpen[m.id] ? '收起追溯' : '追溯记录') + '</button>';
      html += '</div>';
      if (traceOpen[m.id]) html += renderTrace(m);
      html += '</article>';
      return html;
    }

    function renderSlice(m, s) {
      const recs = s.records.map(function (r) {
        const label = r.step + '：' + (r.note || '—');
        return r.state === '已更正' ? '<span class="strike">' + esc(label) + '（已更正）</span>' : '<span>' + esc(label) + '</span>';
      }).join(' / ') || '暂无工序记录';
      let html = '<div class="slice' + (s.frozen ? ' frozen' : '') + '">';
      html += '<div class="slice-head"><b>' + esc(s.id) + '</b><span>';
      html += '<span class="pill">' + esc(s.status) + '</span>';
      if (s.frozen) html += '<span class="badge frozen">冻结</span>';
      if (s.affected) html += '<span class="badge affected">受影响</span>';
      if (s.scrapped) html += '<span class="badge scrap">已报废</span>';
      html += '</span></div>';
      html += '<div class="meta">' + esc(s.method) + (s.observation ? ' · 观察：' + esc(s.observation) : '') + '</div>';
      if (s.frozen && s.frozenReason) html += '<div class="meta">冻结原因：' + esc(s.frozenReason) + '，需复核后恢复</div>';
      html += '<div class="meta">' + recs + '</div>';
      if (!s.scrapped && s.delivery !== '已交付' && !s.frozen && !m.quarantined) {
        html += '<div class="row"><select class="step-sel">' + PIPELINE.map(function (st) {
          return '<option' + (st === s.nextStep ? ' selected' : '') + '>' + st + '</option>';
        }).join('') + '</select>';
        html += '<input class="step-note" placeholder="工序备注 / 观察结果"></div>';
        html += '<div class="row"><button data-act="step" data-master="' + esc(m.id) + '" data-slice="' + esc(s.id) + '">记录工序</button>';
        html += '<button class="ghost" data-act="correct" data-master="' + esc(m.id) + '" data-slice="' + esc(s.id) + '">更正重录</button></div>';
      }
      if (s.frozen && !m.quarantined) {
        html += '<div class="row"><button data-act="review-resume" data-master="' + esc(m.id) + '" data-slice="' + esc(s.id) + '">复核恢复</button>';
        html += '<button class="danger" data-act="review-scrap" data-master="' + esc(m.id) + '" data-slice="' + esc(s.id) + '">复核报废</button></div>';
      }
      if (!s.scrapped && !s.frozen && s.delivery !== '已交付' && !s.nextStep && !m.quarantined) {
        html += '<button data-act="deliver" data-master="' + esc(m.id) + '" data-slice="' + esc(s.id) + '">交付派生片</button>';
      }
      html += '</div>';
      return html;
    }

    function renderTrace(m) {
      const rows = m.records.map(function (r) {
        return '<tr><td>' + r.seq + '</td><td>' + esc(r.sliceId) + '</td><td>' + esc(r.step) + '</td><td>' + esc(r.note || '') + '</td><td>'
          + (r.state === '已更正' ? '<span class="strike">已更正</span>' : '有效') + (r.correction ? '（更正录入）' : '')
          + '</td><td>' + fmtTime(r.at) + '</td></tr>';
      }).join('');
      const events = m.events.slice().reverse().map(function (e) {
        return '<div>' + fmtTime(e.at) + ' · <b>' + esc(e.type) + '</b> · ' + esc(e.detail) + '</div>';
      }).join('');
      return '<div class="trace"><h4>工序台账</h4><table><thead><tr><th>#</th><th>派生片</th><th>工序</th><th>备注</th><th>状态</th><th>时间</th></tr></thead><tbody>'
        + (rows || '<tr><td colspan="6">暂无记录</td></tr>') + '</tbody></table><h4>事件</h4><div class="events">' + (events || '暂无事件') + '</div></div>';
    }

    samplesEl.addEventListener('click', async function (event) {
      const btn = event.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const mid = btn.dataset.master;
      const sid = btn.dataset.slice;
      try {
        if (act === 'derive') {
          const box = btn.closest('.derive');
          await api('/api/samples/' + encodeURIComponent(mid) + '/slices', { method: 'POST', body: JSON.stringify({ id: box.querySelector('.new-slice').value, method: box.querySelector('.new-method').value }) });
        } else if (act === 'step' || act === 'correct') {
          const box = btn.closest('.slice');
          await api('/api/samples/' + encodeURIComponent(mid) + '/slices/' + encodeURIComponent(sid) + '/steps', { method: 'POST', body: JSON.stringify({ step: box.querySelector('.step-sel').value, note: box.querySelector('.step-note').value, correct: act === 'correct' }) });
        } else if (act === 'deliver') {
          await api('/api/samples/' + encodeURIComponent(mid) + '/slices/' + encodeURIComponent(sid) + '/deliver', { method: 'POST', body: '{}' });
        } else if (act === 'contaminate') {
          await api('/api/samples/' + encodeURIComponent(mid) + '/contaminate', { method: 'POST', body: '{}' });
        } else if (act === 'release') {
          await api('/api/samples/' + encodeURIComponent(mid) + '/release', { method: 'POST', body: '{}' });
        } else if (act === 'review-resume' || act === 'review-scrap') {
          await api('/api/samples/' + encodeURIComponent(mid) + '/slices/' + encodeURIComponent(sid) + '/review', { method: 'POST', body: JSON.stringify({ decision: act === 'review-resume' ? '恢复' : '报废' }) });
        } else if (act === 'trace') {
          traceOpen[mid] = !traceOpen[mid];
          render();
          return;
        }
        await load();
      } catch (error) {
        alert(error.message);
      }
    });

    async function load() { samples = await api('/api/samples'); render(); }
    document.querySelector('#reload').onclick = load;
    form.onsubmit = async function (event) {
      event.preventDefault();
      try {
        await api('/api/samples', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset();
        await load();
      } catch (error) {
        alert(error.message);
      }
    };
    load();
  </script>
</body>
</html>`;
