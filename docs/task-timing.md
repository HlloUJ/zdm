# 轻量任务计时

正式启用后，业务和工程任务共用一条本机编号序列。任务登记、单任务执行对话的标题、总协调清单和报告都显示“编号 空格 原任务名称”。本机 Git 公共目录的 zdm-tasks 保存登记和计时，即使任务 Worktree 回收，记录也可以继续查询。迁移主仓库时一并迁移该目录。

## 哪些任务接入

在项目主线查看 `npm run task:timing -- status`。只有 activation 已存在，且独立工作最初的正式交办和已有待办都在其 at 时刻之后，才能登记。看原始任务项的来源。较早任务的重新授权、恢复、返工、换对话、发布、PR 和合并不能产生新号。较早对话中后来单独交办的新任务可登记。计时器自身属于交付前任务。

以下命令在本仓工作目录执行。示例的日期、名称、编号和引用均是占位，执行者使用真实来源。旧工作区可从主工作区调用已发布的 dev/task-timing.mjs，工作目录仍保持为实际操作目录。

## 登记、标题和开工

总协调建待办后，执行者按[统一开发、交付与验证标准](verification.md)接续原号，在任务对话发送开工与改级消息。等级通知的回执保存在任务判级记录内。

执行者从原交办对话的原始用户消息或总协调最初待办取得消息 ID、对话 ID、轮次 ID 和任务项标识。使用 read_thread 定位该项时只取身份和时间，不复制聊天正文。跨对话交接传原任务号。original.at 取原始交办时间，若另有更早的正式待办，将其时间放在 original.todoAt。原始消息是 UUIDv7 时，工具还会取其生成时刻，两者取早。时间缺失且原始记录无可核实时间时，保留原工作流程，等待可核实来源。不得用当前时间或恢复轮次伪造交办时间。

```sh
npm run task:timing -- register - < original-assignment.json
npm run task:timing -- start 023
```

original-assignment.json 的字段如下。可直接把 JSON 作为参数传入，或从标准输入提供。type 可选 business 或 engineering。batch 可选，供同批次查询。独立追加交办可以用 relatedTask 关联已登记的原任务号。

```json
{"name":"优化测试依赖缓存","type":"engineering","batch":"本批工程任务","original":{"kind":"assignment","thread":"原对话ID","turn":"原轮次ID","message":"原交办消息ID","item":"独立任务项1","at":"2026-12-01T09:00:00+08:00"}}
```

总协调用 register 建待办，kind 为 todo。独立任务直接开工时可用 start 接同一份 JSON，一次完成登记和实际开工。start 已有编号取实际开工时刻。重复交办返回同一号。执行者取返回的 fullName，在单任务执行对话调用 Codex 的 set_thread_title，以实际对话 ID 设置标题并读回。总协调或共用对话逐项引用全名。改名用 rename 023 新名称，按相同步骤同步相关显示名称。

## 在现有工程入口计时

exec 给子进程显式传递任务身份，适合已有观测的 V1.1 和 5274 命令。measure 计量所包裹操作的实际起止、结果和退出状态，适合环境准备、依赖、开发命令、推送、创建 PR 及清理。两者直接传递参数，不记录命令参数、输出或凭证。每次操作明确传号，另一个任务复用同一对话或工作区时不会继承上一次的身份。

```sh
npm run task:timing -- measure 023 dependencies -- npm ci
npm run task:timing -- exec 023 -- npm run verify:dev
npm run task:timing -- exec 023 -- node "$(git rev-parse --path-format=absolute --git-common-dir)/../dev/acceptance.mjs" publish
npm run task:timing -- measure 023 merge -- npm run verify:merge -- 12
```

通用阶段包括 prepare、dependencies、development、validation、publish、delivery、push、pr、ci、merge、handoff、cleanup。工作区创建和服务启动归 prepare。主线交接在主线目录显式携带对应任务号运行 sync。确实共用一次操作时可传逗号分隔的已登记编号，例如 measure 023,024 handoff。旧任务照常运行原命令，不设置计时上下文。只读 status 和 plan 本身不计作执行。

V1.1 自动记录每次检查的开始、失败、成功或复用及来源。复用只计本次核验耗时。工程任务首次完整 dev 验证通过记为验证就绪。业务任务以实际 publish 成功、指定版本进入健康的 5274 记录为首次可验收。

## 通知、等待、返工和结项

mark 的阶段包括 started、paused、resumed、notified、feedback、delivery-request、scope-added、closed、cancelled。scope-added 引用本任务新增范围的原始指令，保留既有任务状态。由执行者在原动作处记录 ref 和真实 at。通知与反馈提供指定版本的完整 SHA。实际通知至对应版本反馈或交付指令形成待反馈区间。源码合入、通知发送和完整交付各有独立时刻。最后一项必要交接和清理完结后才标记 closed。

```sh
npm run task:timing -- mark 023 '{"stage":"notified","at":"2026-12-01T10:00:00+08:00","ref":"验收通知消息ID","revision":"指定版本完整SHA"}'
npm run task:timing -- begin 023 '{"key":"wait-1","stage":"wait:ci","ref":"对应CI链接"}'
npm run task:timing -- begin 023 '{"key":"block-1","stage":"blocked:ci","wait":"wait-1","ref":"确认只能等待的记录"}'
npm run task:timing -- end 023 '{"key":"block-1","status":"passed","ref":"解除阻塞记录"}'
npm run task:timing -- end 023 '{"key":"wait-1","status":"passed","ref":"CI开跑记录"}'
```

wait 和 blocked 可选 user、ci、resource、dependency、approval、delivery。实际受阻须关联同一原因的等待，扣除同任务仍在执行的本地工作。begin 和 end 可提供带时区的原始 at，补录要附原始 ref。结束时间未知的中断用 interrupted 标记，保留原始开始与中断观察，不估算结束时间。

返工开始时用 begin 登记 stage 为 rework:feedback 或 rework:validation，key 识别这一轮，ref 使用原反馈消息或故障记录的同一标识，验收返工可附原版本 revision。报告用相同 ref 的反馈计算反馈至实际开始处理的时长。随后通过 exec 023 --round 轮次号 -- 命令 或 measure 023 development --round 轮次号 -- 命令关联同轮操作。健康重提验或相应完整验证通过后自动结束适用轮次，定向复验亦可按原记录显式 end。多个复验保留各自尝试。同一版本、同一源码树和检查范围失败后重跑时，报告先记原因待核。有环境故障依据时用 retry-cause 023 传入 previous、attempt、cause（environment）、ref 和 at，引用报告中的两次执行号。独立新增需求按原始新交办另登记。

## PR、CI 和报告

在任务目录创建 PR 后运行 link-pr 023 PR号，核对当前 HEAD、同仓 PR 及目标 main。候选更新后重新关联新版本。收尾时 sync-pr 023 把远端 PR 和 CI 元数据写入本地，report 的 --live 可只读查询最新状态。按 PR、版本、运行、尝试和作业识别来源。只有运行创建与首个作业开跑时刻时显示为 CI 启动前等待，实际受阻须有额外依据。

```sh
npm run task:timing -- link-pr 023 12
npm run task:timing -- sync-pr 023
npm run task:timing -- report 023 --live --json
npm run task:timing -- summary --type engineering --json
```

“查 023 的耗时”读取单项报告。“汇总本批同类任务”读取 summary，支持 --batch、--type、--risk、--scope 和带时区的 --from、--to。默认输出简报，--json 提供完整明细。比较开工至首次就绪和完整交付的中位数，结合样本数、验证范围、首次完整开发验证通过率、返工、阻塞和未知占比。并行时间按区间并集计算，报告另列各任务累计执行量。缺消息、缺结束和进行中均保留实际含义。

只有已证实来自启用后新任务、具体归属仍待核的事件可用 unassigned 记录，传原始 original、稳定 key、阶段 stage、ref 和实际 at。resolve 编号 key 在原交办身份吻合时归属为可核实的观察点。范围外任务不进入待归属清单。

## 首次正式启用

交付前用独立测试仓库验证。计时器首次进入远端 main、该主线 CI 通过、本地主线与 5274 交接及任务收尾完成后，在主工作区运行 activate，传入该次 PR、主线合并提交和主线 CI 运行号。工具核对远端证据、主线及已完成的 5274 交接，使用当前正式交付时刻写入一次性的 activation.json。不得预启用、回填较早界线或导入旧任务。已有同一发号序列时可提供 lastNumber，默认新序列从 001 开始。

```json
{"commit":"首次交付计时器的主线合并提交","pr":12,"ciRun":12345}
```
