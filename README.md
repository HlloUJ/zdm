# 装点猫管理后台

使用 Node.js 24、npm 和 Docker Compose。每个工作目录有独立的前后端端口、MySQL、媒体和 Maven 缓存。数据库与记录服务仅在本目录的 Compose 网络内可见。初次启动需要下载 npm 和 Maven 依赖。

```sh
npm ci
npm run env:init -- 5273 8280
npm run backend:dev
npm run dev
```

访问 `http://127.0.0.1:5273`。后端健康地址为 `http://127.0.0.1:8280/actuator/health`。开发配置只在本机使用，`.env` 保存该目录的数据库名称和随机凭证。保管好此文件，已有环境可直接启动。

## 并行开发

在同一仓库创建第二个分支及工作目录，然后分配两个空闲端口。

```sh
git worktree add -b feature/example ../zdm-example main
cd ../zdm-example
npm ci
npm run env:init -- 5276 8283
npm run backend:dev
npm run dev
```

各分支经普通 Git 提交和 PR 合入 main。前端用 Ctrl-C 停止，临时停用后端可用 `docker compose stop` 保留容器。`docker compose down` 会移除容器和其中的可写层。运行 `down` 或任何可能重建容器的命令前，按[任务环境清理流程](docs/task-completion-cleanup.md)核对受影响容器的归属、可写层和挂载，先保全唯一资料。门店退出记录使用与业务库同一作用域的鉴权和独立持久卷。恢复既有数据库时，应由数据所有者配套核对该环境的媒体和独立退出记录。

## 业务任务统一验收（5274）

[5274](http://127.0.0.1:5274/login) 运行最新已同步的 `origin/main` 和仍待验收的业务版本。并行任务继续使用各自的开发分支与工作目录。5274 使用固定验收工作目录和现有验收库、媒体及门店退出记录卷。

`publish`、`sync` 或 `recover` 涉及容器重建时，执行前先按[任务环境清理流程](docs/task-completion-cleanup.md)核对受影响容器并保全唯一资料。归属或恢复来源待核实时保留原容器。

- 开发完成和返工复验时，执行者在该任务目录保存完整本地 checkpoint，然后运行 `node "$(git rev-parse --path-format=absolute --git-common-dir)/../dev/acceptance.mjs" publish`。成功后把 5274 链接和任务版本交给用户验收。出现冲突时，5274 继续展示上一次成功的组合。
- 用户对某项任务发出「任务完成」后，在其任务目录用同一命令将 `publish` 改为 `verify`，核对该任务的验收版本。按普通 Git/PR 流程从该任务分支独立交付。组合版本只在本机验收目录使用。
- 合并后在主线目录同步远程主线，运行 `node dev/acceptance.mjs sync`。这一步只移除真实进入 `origin/main` 历史的任务版本，其他版本继续参与验收。若交付中因主线同步产生技术合并提交，仍以实际验收提交进入主线历史为准。
- 主线目录运行 `node dev/acceptance.mjs status` 可查看上次成功的组合。部署中断且留下 `pending` 时，核实旧执行进程已退出后用 `recover` 恢复上次组合；异常退出留下的 `zdm-acceptance.lock` 空目录在确认无执行者后可移除。运行目录和验收库继续保留。

已有 5274 的迁移需将前后端绑定到专用的分离 HEAD 工作目录，同时延用原 Compose 配置的数据库身份和外部持久卷，并在该目录的 `.private/acceptance-runtime.json` 登记底层项目、数据库和卷名。待前端与后端健康后，在主线运行 `node dev/acceptance.mjs init <验收目录> [当前验收分支]`，然后运行 `sync` 完成首次组合。脚本不会重新初始化、删除或切换验收卷。发现已有 Flyway 迁移文件发生变更时暂停预览更新以保护现有库；新增迁移在更新前会保留 SQL 备份，并将配套图片和退出账本复制到演练专属卷。演练在 Flyway 完成迁移时核对已有列的全部行值及重复次数，候选启动后再核对原表行数、原文件内容和服务健康。新表和新增列可以参与升级。

## 构建与业务测试

[V1.1 分级验证](docs/verification-v1.1.md)统一开发与合并前的清单。开发或返工运行 `npm run verify:dev`，正式合并使用 `npm run verify:merge -- <PR编号>`。

```sh
npm run build
npm run test:unit
npm run backend:test
npm run test:ledger
npx playwright install chromium
npm run test:e2e
```

自动化页面测试另起本机端口，默认 5275，可用环境变量 `ZDM_E2E_PORT` 指定。本机已有 Google Chrome 时可设置 `PLAYWRIGHT_CHANNEL=chrome`。项目级 Skill 位于 `.agents/skills`。产品架构图与规则见 `docs/product-architecture.md` 和 `AGENTS.md`。获授权的协作者可在团队 Notion 工作区按文档标题检索产品原件，或向项目所有者取得私有索引。

## 既有数据库

公开开发数据使用示例管理员手机号 `19900009901`。曾运行原系统的数据库继续使用原版 V5 和 V132 迁移。项目所有者在仓库外保存了这两个原件和只读挂载配置。使用既有数据前请先取得该配置，以原版迁移进行 Flyway 校验，保持已执行迁移的校验和。正式凭证通过环境注入。公共开发配置连接各工作目录新建的本地测试库。

在 macOS 或 Linux 的既有库隔离副本工作目录，先运行 `npm run env:init` 分配独立资源，再在该目录的 `.env` 增加以下配置。原始迁移由库所有者提供，两个文件必须与该库已执行的版本相符。Compose 会将它们只读挂载到 Maven 源码路径。

```dotenv
COMPOSE_FILE=docker-compose.yml:compose.private-migrations.yml
ZDM_PRIVATE_MIGRATIONS_DIR=/absolute/path/to/private-migrations
```

在已恢复隔离副本的对应 Compose 数据库上运行 `npm run backend:dev`。首次连接会按 Spring Boot 的正常 Flyway 流程先校验已有迁移，再执行尚未应用的版本。可用 `npm run backend:logs` 查看校验结果。已有库运行与自动化业务测试各自使用独立的构建输出。测试使用公开的合成数据和 Testcontainers 新建的测试库。新建普通测试库直接使用前述开发命令。
