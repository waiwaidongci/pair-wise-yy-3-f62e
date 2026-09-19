# 岩芯样本切片实验室

运行：

```bash
npm start
```

访问`http://localhost:3025`。支持样本创建、原片派生、工序登记与更正、污染隔离、冻结复核和交付统计。

## 切片派生与污染冻结闭环

- 每张原片可派生多张派生片：派生片必须绑定有效原片，编号全局唯一（重复编号返回 409）。
- 原片标污染（进入隔离）或工序更正导致状态回退时：未交付派生片立即冻结，已交付派生片保留历史并标记受影响。
- 派生片依次完成切割、研磨、染色、观察；任一工序更正后作废其下游记录，并重算原片与全部下游状态。
- 同一原片同一工序只保留一条有效记录，并发提交只成功一次（其余返回 409）。
- 原片隔离期间不得继续派生；解除隔离后冻结派生片不自动恢复，需逐张复核。

## 模块划分

- `server.js`：启动入口（`npm start`，端口 3025，可用 `PORT` / `DATA_FILE` 覆盖）。
- `src/app.js`：请求入口（HTTP 路由与参数校验）。
- `src/domain/status.js`：状态计算（工序记录、更正、冻结级联、复核、状态重算）。
- `src/store/repository.js`：记录存储（JSON 持久化、旧数据迁移、串行写入）。
- `src/ui/page.js`：页面模板。

## 主要接口

- `GET /api/samples`：样本列表（含原片与派生片状态）。
- `POST /api/samples` / `POST /api/samples/:id/slices`：创建样本 / 添加原片。
- `POST /api/samples/:id/slices/:sliceId/logs`：原片工序登记（`correct:true` 表示更正）。
- `POST .../slices/:sliceId/derived`：派生切片；`.../derived/:derivedId/records`：派生片工序登记。
- `POST .../slices/:sliceId/contaminate` / `release`：标污染隔离 / 解除隔离。
- `POST .../derived/:derivedId/deliver` / `review`：交付派生片 / 逐张复核恢复。
- `GET .../slices/:sliceId/trace`：追溯视图（有效/作废记录、污染历史、派生片事件）。

列表、追溯与刷新后的状态均由同一存储重算得出，保持一致。
