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
npm run env:init -- 5274 8281
npm run backend:dev
npm run dev
```

各分支经普通 Git 提交和 PR 合入 main。前端用 Ctrl-C 停止，后端用 `docker compose down` 停止并保留数据。门店退出记录使用与业务库同一作用域的鉴权和独立持久卷。恢复既有数据库时，应由数据所有者配套核对该环境的媒体和独立退出记录。

## 构建与业务测试

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
