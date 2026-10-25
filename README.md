# 宇宙万物观测站

一个可在单机运行的对象观测系统：接收发生器 HTTP 消息，将原始请求可靠保存，整理对象和类型索引，再通过浏览器探索变化中的数据。界面位于 `http://localhost:8000`。

## 快速启动

要求 Docker Desktop（Mac Apple Silicon / Linux arm64）。在仓库根目录执行：

```sh
docker compose up --build -d
curl -fsS http://localhost:8000/health
```

发生器镜像来自题目附件，**不包含在本仓库中**。将附件解压后，在包含 `flightgen-image.tar` 的目录执行：

```sh
docker load -i flightgen-image.tar
mkdir -p generator-runs
docker run -d --name object-source \
  --cpuset-cpus=0 --cpus=1 --memory=256m --memory-swap=256m \
  -p 127.0.0.1:9001:9001 \
  -v "$PWD/generator-runs:/runs" \
  talkingdata/flightgen:exam-v4-f1
```

启动一次观测（每次更换 `test_id`）：

```sh
curl -fsS http://127.0.0.1:9001/start \
  -H 'Content-Type: application/json' \
  -d '{
    "workload":"objects",
    "target_url":"http://host.docker.internal:8000/ingest",
    "test_id":"run-001",
    "seed":42,
    "batch_size":20,
    "workers":4,
    "objects_per_second":200,
    "rate_profile":"bursty",
    "ramp_seconds":10,
    "duration_seconds":120,
    "max_batches":20000,
    "retries":2,
    "objects":{"scenario":"evolving","tree_every_batches":10}
  }'
```

运行中用 `curl -fsS http://127.0.0.1:9001/status` 查看状态；结束后用 `curl -fsS http://127.0.0.1:9001/receipt -o receipt.json` 保存发生器报告。停机：`docker compose down`。不要加 `-v`，否则会删除持久化数据卷。

## 系统设计

- **可靠接收**：`POST /ingest` 限制单条消息 8 MiB。有效 JSON 作为原始字节写入 SQLite，最多 64 条请求组成一次事务（或等待 5 ms），以 WAL + `synchronous=FULL` 提交后才返回 2xx；数据库出错返回 503。无效 JSON 返回 400。原始请求以 SHA-256 去重，发生器重试不会重复计数。
- **可追溯索引**：同一事务中提取对象及类型节点。对象键为 `(test_id, object_id)`，较旧的 `sequence/version/revision` 不覆盖较新的版本。原始消息永久保留，可从 `/api/message?id=…` 查看。
- **探索界面**：实时概览、每分钟接收曲线、类别分布、任务与类别筛选、对象详情、类型节点及最近消息。前端每 5 秒刷新。
- **资源**：单个 Node.js 服务和 SQLite 数据库；Compose 限制服务为 3.5 vCPU、3.5 GiB。发生器单独占 1 vCPU、256 MiB。接收端数据库文件总量达到约 18 GiB 时返回 507，预留 WAL、元数据及容器空间；Docker 卷本身仍需在宿主机保证 20 GiB 可用空间。

### API

| 路径 | 作用 |
|---|---|
| `POST /ingest` | 接收 JSON 消息，提交成功后确认 |
| `GET /health` | 进程健康状态 |
| `GET /api/summary` | 总量、类别和任务 |
| `GET /api/activity` | 最近分钟级消息量 |
| `GET /api/objects?q=&test_id=&category=&limit=&offset=` | 对象分页查询 |
| `GET /api/object?id=&test_id=` | 对象完整属性 |
| `GET /api/types?test_id=` | 类型节点 |
| `GET /api/messages`、`GET /api/message?id=` | 最近消息与原始请求 |

## 数据格式探索

题目没有公开 payload schema。本地环境没有 Docker 命令，因此未能启动发生器采样。静态检查了附件镜像的 OCI 配置和二进制字符串：镜像为 Linux arm64，入口 `/flightgen`；配置包含 2% 重复、1% 不完整、1% 无效注入参数；字符串显示对象消息、`event_id`、`test_id`、`sequence`、`batch_id`、类型树的 `type_id` / `parent_id` / `revision`，以及 `position`、`attributes` 等字段。**这些线索并不等于实际 payload 验证。**

因此接收端先保存整个有效 JSON，再做宽容的二级提取：递归寻找带 `id/object_id/entity_id` 和对象属性的条目，识别 `tree/type_tree/taxonomy` 中的节点。未知字段在原始消息中无损保留。拿到真实发生器环境后，应运行上述 120 秒任务，查看 `/api/message` 样本和 receipt，调整提取规则并核对发送、确认与入库数量。

## 实际测试结果

当前开发机为 Windows，Node.js v24.18.0；**没有安装 Docker，未在 Mac Linux arm64 容器内测试，也未执行真实发生器任务**。可复现的本地测试：

```sh
node --test
node server.js
node scripts/bench.js
```

- 集成测试：1 项通过。验证完整写入、重复请求去重、旧版本不覆盖新版本、类型树、无效 JSON 拒绝和查询接口。
- 本机合成吞吐：8 个并发客户端发送 1,000 批、每批 20 对象；1,000 批成功、0 失败、共 20,000 对象，耗时 3.149 秒，约 6,351 对象/秒。测试时数据库已有上一轮的 10,000 个对象。使用本机 Windows 文件系统及短属性对象，**不是**真实发生器或 Mac Docker 的性能结论。

## 关键取舍与已知限制

SQLite 的单进程事务使确认语义和部署简单，代价是单写入线程，高并发写入和大型 JSON 的 CPU 开销会限制峰值吞吐。对象和类型索引与原始消息同事务写入，保证查询不会先于确认看到半条消息。当前 `LIKE` 搜索不适合千万级全库模糊检索；后续可加 FTS 索引或限定时间窗。分类字段是基于未知 schema 的启发式推断，真实 payload 若使用不同结构，对象索引可能缺失，但原始消息仍在。对象删除事件、类型树重命名和跨批次业务校验尚未针对真实发生器验证。消息长期保留，在接近空间上限时停止确认，需要归档或扩容后继续运行。

本仓库没有采用用户给出的 `python main.py` 示例命令：实际入口是 `node server.js`，验收环境统一用 `docker compose up --build -d`。
