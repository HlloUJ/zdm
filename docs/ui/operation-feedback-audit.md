# 管理后台操作校验与反馈逐页审计

任务 004 的扫描基线为 `dfb778aa`。[已确认整改方案](https://chatgpt.com/space/page_9a724ffad3f88191a0b1d147513cc996) 与[逐页原始清单](https://chatgpt.com/space/page_c2e0742cdfb881919cf47175e709335f)保留原始证据。[有效标准](operation-feedback-standard.md)和[操作登记](operation-feedback-registry.json)用于持续检查。

## 37 个整改路由

下表的页面路径相对 `src/pages`。目录入口均为 `index.vue`。“页面回调”指 `src/__tests__/operationFeedbackPages.test.ts` 用实际页面回调与受控 HTTP 响应执行的测试。后端用例运行于独立数据库；完整验证结果以项目 V1.1 记录为准。

| 实际路由 | 实现 | 操作 | 核对条件或结果 | 对应用例 |
| --- | --- | --- | --- | --- |
| `/product-category` | `product/category` | 删除分类 | 下级、商品、属性模板；提交时复核 | 页面回调、PlatformApiSmokeTest |
| `/store-category-management` | `store-category/management` | 删除分类 | 门店与成品／配件分类作用域；下级与应用商品 | 页面回调、StoreCategoryService |
| `/product-attribute` | `product/attribute` | 删除属性 | 业务／物理删除、真实占用和过期预检 | 页面回调、ProductAttributeLifecycleApiTest |
| `/store-level-management` | `store-level/management` | 删除与停用 | 区分引用、请求异常、false 和 A/B 返回顺序 | 页面回调、store-level.spec.ts |
| `/category-attribute-template` | `product/category-attribute-template` | 新建、复制、发布草稿 | 按当前末级分类与 create 权限检查状态；保留草稿覆盖、保存与发布确认 | category-attribute-template.spec.ts |
| `/supplier-management` | `supplier/management` | 删除供应商 | 按供应商范围检查库存、成品和配件引用 | 页面回调、PlatformApiSmokeTest |
| `/supplier-supply-type-management` | `supplier/supply-type` | 删除供货类型 | 供应商引用阻断；正常删除保留确认 | PlatformApiSmokeTest、页面回调 |
| `/slab-variety` | `slab/variety` | 删除品种 | 当前资料的库存外键引用与最终提交 | 页面回调、PlatformApiSmokeTest |
| `/slab-origin` | `slab/origin` | 删除产地 | 当前资料的库存外键引用与最终提交 | 页面回调、PlatformApiSmokeTest |
| `/slab-texture` | `slab/texture` | 删除纹理 | 当前资料的库存外键引用与最终提交 | 页面回调、PlatformApiSmokeTest |
| `/slab-color` | `slab/color` | 删除色系及色系分类 | 库存引用、色系对分类的引用 | 页面回调、PlatformApiSmokeTest |
| `/slab-grade` | `slab/grade` | 删除等级 | 当前资料的库存外键引用与最终提交 | 页面回调、PlatformApiSmokeTest |
| `/markup-configuration` | `product/markup-configuration` | 删除成品／配件价格配置 | 按当前类型检查价格引用；大板继续使用原引用数 | 页面回调、两端价格配置 E2E |
| `/tenant-management` | `tenant/management` | 归档、彻底删除 | 预检可执行才绑定名称和清理方案；保留名称核对 | 页面回调、PlatformApiSmokeTest |
| `/tenant-store-management` | `tenant/store` | 恢复运营、彻底删除 | 所属租户状态；不可删原因与检查异常；保留 planHash | 页面回调、PlatformApiSmokeTest |
| `/supply-chain/finished-stock-management` | `finished-stock/supply-chain` | 单条上架 | 供应链权限、来源状态、必备资料、库存及规格成本价 | FinishedProductPermissionApiTest |
| `/store/finished-stock-management` | `finished-stock/store` | 单条上架 | 当前门店商品、来源、分类及售价；双缺项一次提示 | StoreFinishedProductServiceTest |
| `/finished-stock-management` | `finished-stock/management` | 单条上架 | 运营端 shelf-check；预检失败与提交失败分别给错误 | 运营端权限 E2E、FinishedProductPermissionApiTest |
| `/supply-chain/accessory-management` | `finished-stock/supply-chain` | 单条上架 | 供应链权限、来源状态、必备资料、库存及规格成本价 | AccessoryProductPermissionApiTest |
| `/store/accessory-management` | `finished-stock/store` | 单条上架 | 当前门店商品、来源、分类及售价；双缺项一次提示 | StoreAccessoryProductServiceTest |
| `/accessory-management` | `finished-stock/management` | 单条上架 | 运营端 shelf-check；预检失败与提交失败分别给错误 | 运营端权限 E2E、AccessoryProductPermissionApiTest |
| `/slab-management` | `slab/management` | 行操作、原有批量预检 | 按运营端判断；已知条件与网络异常分别提示 | slab-collaboration.spec.ts、SlabCollaborationApiTest |
| `/supply-chain/slab-management` | `slab/supply-chain` | 行操作、原有批量预检 | 按供应链自身状态；保留各批量入口策略 | slab-collaboration.spec.ts、SlabCollaborationApiTest |
| `/store/order-management/sales` | `order/prototype` | 确认订单、收退款 | 模拟订单行可用性与不可补货库存；字段校验与提交异常分流 | store-order-prototype.spec.ts、model.test.ts |
| `/store/order-management/fulfillment` | `order/prototype` | 发货和到店收货 | 数量及时间字段定位；门店核验或服务异常单独反馈 | store-order-prototype.spec.ts、model.test.ts |
| `/store/order-management/settings` | `order/prototype` | 款项名称新增或修改 | 重名错误有服务端字段标识；网络异常不标红名称 | store-order-prototype.spec.ts、model.test.ts |
| `/store/finished-stock-management/:id/edit` | `finished-stock/store/StoreFinishedEditor.vue` | 保存门店商品 | 在首个异步字段检查前锁定，失败或完成时释放 | 门店商品 E2E、页面回调 |
| `/store/accessory-management/:id/edit` | `finished-stock/store/StoreFinishedEditor.vue` | 保存门店商品 | 在首个异步字段检查前锁定，失败或完成时释放 | 门店商品 E2E、页面回调 |
| `/store/price-configuration` | `finished-stock/store/price-configuration.vue` | 保存折扣 | 从字段校验起锁定；区分新增与修改错误 | store-price-rules.spec.ts、页面回调 |
| `/employee-invite` | `employee-invite` | 获取验证码 | 异步字段校验之前即进入处理中 | 页面回调 |
| `/store/customer-management` | `customer` | 删除跟进记录 | 按 DELETE 真实结果提示，单独处理刷新异常 | customer-management.spec.ts、页面回调 |
| `/store/selection-center` | `selection-center` | 移除清单项 | 同门店上下文、同条目串行；加入门店沿用逐项结果 | 页面回调、selection-center.spec.ts |
| `/finished-stock-craft` | `craft/finished-stock` | 删除工艺 | 同条去重；返回 false 不移除记录 | 页面回调 |
| `/product-attribute-value` | `product/attribute-value` | 删除属性值 | 保留原权限与执行结果；确认阶段同条去重 | 页面回调 |
| `/employee-management` | `permission/employee` | 删除员工 | 保留本人及超级管理员保护、供应链管理员分支 | 页面回调、permission-center.spec.ts |
| `/role-management` | `role/management` | 删除角色 | 保留店长及超级管理员角色保护；确认阶段去重 | 页面回调、permission-center.spec.ts |
| `/terminal-function-allocation` | `permission/terminal-function` | 保存终端权限 | 结果只归属发起终端；切页签保留当前勾选与提示 | 页面回调、permission-center.spec.ts |

## 共享页面、独立顶栏及跳转

- 配件的运营、供应链、门店及门店编辑四个路由通过 `src/modules/accessory/routes.ts` 注入配件模块。成品页面与配件页面共用 Vue 实现，服务、功能权限和当前门店范围分别由 `useCommodityModule` 与相应控制器解析。四个配件路由各计一次。
- 三个订单子路由由同一 `order/prototype/index.vue` 承载，销售与履约复用 `OrderActionDialog.vue`。门店商品列表和 `:id/edit` 分别有独立访问入口。
- `src/components/AdminTopNav.vue` 的退出登录从第一次点击起进入原生 loading，退出请求完成后切换至登录页。共享顶栏单列一次，页面回调用例验证连点只发送一次退出请求。登录页 `/login` 与工作台 `/dashboard` 在原扫描中未发现页面自身的确定问题，均进入源码登记。
- 六个纯跳转地址见下表。业务页面与其历史跳转不重复计数。

| 原地址 | 实际地址 |
| --- | --- |
| `/` | `/login` |
| `/store/order-management` | `/store/order-management/sales` |
| `/finished-stock-category` | `/product-category` |
| `/accessory-category` | `/category-attribute-template` |
| `/finished-stock-attribute` | `/product-attribute` |
| `/accessory-attribute` | `/product-attribute-value` |

## 批量与提交边界

业务阻断通过结构化预检或服务端明确的业务拒绝标志传递。未分类的 HTTP 400、网络异常和无效预检结果走错误反馈。只读检查与提交分别核验权限和对象，最终提交继续按当前数据执行。

逐件上架和批量删除沿用现有成功数、失败对象与原因。选品加入全部成功时给成功提示，部分或全部失败保留结果弹框。事务型动作继续整批复核。供应链成品、配件批量下架按选择顺序提交，成功项移出选择，遇错保留失败及未执行项。运营端对应的独立请求沿用并发执行。两条路径分别由成品和配件管理 E2E 覆盖。代码登记把表单、查询、单条、批量和混合回调的具体分支分开，运行源码守卫可用 `npm run test:source-guards`。

公共生命周期测试位于 `src/composables/useOperationPreflight.test.ts`，覆盖路由、页签、身份切换、卸载、同键重入和旧执行返回。五处 false 结果、18 个重复调用入口以及属性／级别／租户倒序预检列入页面回调用例。商品分类的首次阻断与确认期间新增模板引用在 `PlatformApiSmokeTest` 中复核。

选品中心在 004 独立版本和与 003 的验收组合中均保留移除防重。门店切换再返回时，旧移除请求的成功及失败响应均由页面回调用例覆盖。003 的逐批浏览、新增查询入口、清单分页和店员选品标记沿用其发布提交 `ff42c972`。操作登记按两版选品服务的准确 SHA-256 选择对应的页面脚本、全部操作和变更前指纹，两版均逐项执行同一套源码检查。

款项设置页与 005 的验收版本 `dfed9fa7` 同时使用时，分页保留 10、20、50 条选项。组合页有独立登记的脚本和精确变更前指纹。新增、修改遇到重名时，端到端用例验证名称字段；真实数据库 API 用例验证两种操作的字段标识及旧版本提交的非字段错误。

34 个改动组件的获批补丁逐份反向还原并核对扫描基线文件的 SHA-256。已有视觉契约中的差异追加在 [视觉契约](visual-refactor.json) 的 `approvedBusinessPatches`，其余组件的补丁与原始指纹保存在[操作登记](operation-feedback-registry.json)中。

## 013 表单字段反馈

以当前主线路由、运行时组件登记和保存接口为检查范围。品种、产地、纹理与别名、色系与分类、等级、供货类型、供应商、租户、门店、角色、员工、客户、商品分类属性、成品及配件、两端大板、门店价格配置和款项名称的字段错误接入实际编辑控件。只读详情、查询、上下架预检、删除确认及网络错误沿用各自的操作反馈。新接入的后台和表单遵循同一标准。

具体回归位于 `tests/e2e/submit-failure-feedback.spec.ts`、`tests/e2e/feedback-foundation.spec.ts`、`src/utils/serverFieldValidation.test.ts` 及后端 `PlatformApiSmokeTest`。分别检查空表单、品种和门店重名、修改后重提、多字段错误、过期响应、并发写入和普通请求失败。
