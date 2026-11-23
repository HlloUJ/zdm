---
name: zdm-task-assessment
description: 装点猫管理后台直接交办或总协调派发的任务实际开工、接手、恢复、返工、级变和交付复核时使用。待办登记、普通问答和同轮命令重试沿用原记录。
---

# 任务执行等级与复核

读取[仓库统一标准](../../../docs/verification.md)的生效修订。总协调传原交办、验收条件和有效资料引用。执行者按该任务真实行为和后果判定，等级和专项由统一标准维护。

## 开工与通知

1. 总协调用计时器 register 登记待办，执行者在首次实际开工运行 task:timing -- start 接续原号。恢复和返工按任务计时入口留下实际事件。没有正式号的旧任务用稳定的 `ref:<原始交办标识>`。从实际任务工作区执行，旧工作区使用已同步主线的 `dev/quality-entry.mjs assess`。先用 `npm run task:assess -- show <身份>` 读回修订和待发通知。
2. 实际开工时用 `npm run task:assess -- start <身份> -` 从标准输入传 JSON。填写 `expected`（新任务为 0）、真实轮次 `event`、执行对话 `thread`、`kind`（start、resume、handoff、rework、adopt 或 late）、任务全名 `name`、原交办 `source`、条款或基线定位数组 `references`、改前 `before`、改后 `after`、使用方数组 `consumers`、数据影响 `data`、未知项 `unknown` 和理由 `reason`。用 `behaviors` 登记整项行为，必要时用 `roundBehaviors` 区分本轮。可用 `npm run task:assess -- catalog` 查输入值。同批任务各用自己的身份和实际文件 `paths` 登记。
3. 按返回的 `pending` 到对应任务对话发送任务全名、等级、依据和选测变化。恢复时先查目标对话，已有同一条真实通知就关联原消息。送达后用 `npm run task:assess -- ack <身份> -` 传 `event`（待发项的 key）、`thread`、`message` 和实际发送或查见时刻 `at`。暂时无法发出时保留待发。验收计时的 `notified` 单独使用。

## 复核与交付

- 可测改动后运行 `verify:plan` 和 `verify:dev`，核对本轮和整项、实际使用方、漏项及定向用例。需求或依据修订时用 `task:assess -- review <身份> -` 提交真实事件、执行对话、前一修订和原因，需要时传修订后的 `intent`。降档事实或用户明确收缩范围的依据填入 `disposition`。处理每一条真实变级通知。
- 业务提验沿用 5274 发布和健康验证。PR 创建前用 `task:assess -- summary <身份或逗号分隔的多任务>`，把返回的 `block` 放入 PR 描述。提交、主线或公开摘要变化后重新复核。CI 有结果时在实际任务工作区运行 `task:assess -- ci <身份> <PR号>`，将新增待发事件送回所属任务对话，再按现行入口合并。
- 用 `show` 核对送达，用 `task:timing -- report <编号> --json` 核对实跑、复用、失败和耗时。
