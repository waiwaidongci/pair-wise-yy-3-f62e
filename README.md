# 岩芯样本切片实验室

运行：

```bash
npm start
```

访问 `http://localhost:3025`（端口可用 `PORT` 覆盖，数据文件可用 `DB_PATH` 覆盖）。

## 切片派生与污染冻结闭环

- **派生**：每张原片可派生多张切片（`POST /api/samples/:id/slices`），派生片必须绑定有效原片且编号全局唯一；原片未解除隔离不得继续派生。
- **工序**：派生片依次完成 切割 → 研磨 → 染色 → 观察（`POST .../slices/:sid/steps`）。同一原片同一工序只保留一条有效记录，并发 / 重复提交只有第一次成功（409）；带 `{"correct": true}` 视为更正，本工序及全部下游有效记录作废并重算原片与下游状态。
- **冻结**：原片标记污染（`POST .../contaminate`）或状态回退时，未交付派生片立即冻结，已交付派生片保留历史并标记受影响。
- **复核**：解除隔离（`POST .../release`）后冻结片不自动恢复，需逐张复核（`POST .../slices/:sid/review`，`decision` 为 `恢复` 或 `报废`）。
- **交付**：完成全部工序后按片交付（`POST .../slices/:sid/deliver`）。
- **追溯**：`GET /api/samples/:id/trace` 返回工序台账（含已更正记录）与事件流；列表、追溯、刷新后的状态均由同一份记录现算，保证一致。

## 模块划分

- `server.js` — 启动入口（`npm start` 不变）
- `src/http/router.js` — 请求入口：路由、参数解析、错误映射
- `src/http/page.js` — 单页视图
- `src/domain/lab.js` — 状态计算：工序流水、状态重算、污染冻结级联
- `src/store/repository.js` — 记录存储：JSON 台账、串行事务（写操作原子落库）、旧版数据迁移
