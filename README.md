# 需求评估助手 Stage 2

这是从纯前端 HTML 升级到“前端 + 后端代理”的阶段二版本，适合 AI 定制、AI 工作流、AI 智能体、FDE 售前初筛使用。

## 它解决什么

- 客户需求初筛：判断是否是真需求、是否有预算、是否值得推进。
- 售前追问：自动生成 4-6 个关键追问。
- 交付评估：输出交付边界、MVP 路径、周期、团队角色、验收标准。
- 报价策略：诊断费、PoC 报价、完整项目报价、付款节点。
- 红线判断：识别无预算、无数据、无决策权、验收不清等风险。
- 收入目标匹配：围绕“保底团队月入 2 万、起步月入 5 万、最终月入 50 万、年入 600 万”判断项目是否值得推进和规模化。

## 阶段二相对原版的关键变化

1. API Key 不再放浏览器 localStorage，而是放服务端 `.env`。
2. 前端只请求自己的后端接口：`/api/questions` 和 `/api/evaluate`。
3. 增加红线判断、报价策略、销售动作、收入目标匹配度。
4. 增加后端健康检查：`/api/health`。
5. 可选本地记录评估结果，但默认关闭。

## 快速启动

```bash
cd demand-evaluator-stage2
npm install
cp .env.example .env
# 编辑 .env，填入 MODEL_API_KEY
npm run dev
```

打开：

```text
http://localhost:8787
```

## .env 配置说明

```env
PORT=8787
MODEL_PROVIDER=openai-compatible
MODEL_API_URL=https://api.deepseek.com/chat/completions
MODEL_API_KEY=replace-with-your-server-side-key
MODEL_NAME=deepseek-chat

BASELINE_MONTHLY_TARGET=20000
EARLY_MONTHLY_TARGET=50000
TARGET_MONTHLY_REVENUE=500000
ANNUAL_REVENUE_TARGET=6000000
TEAM_SIZE=2-3
STORE_EVALUATIONS=false
```

### OpenAI 兼容接口

适合 DeepSeek、OpenAI 兼容网关、部分国产模型兼容接口。

```env
MODEL_PROVIDER=openai-compatible
MODEL_API_URL=https://api.deepseek.com/chat/completions
MODEL_NAME=deepseek-chat
```

### Anthropic Claude

```env
MODEL_PROVIDER=anthropic
MODEL_API_URL=https://api.anthropic.com/v1/messages
MODEL_NAME=claude-sonnet-4-20250514
```

## 安全说明

- 前端不会看到真实 API Key。
- 用户输入会发送到你配置的模型服务商，不要写“数据不上传”。
- 如果公开部署，必须增加登录、权限、用量限制和日志脱敏。
- `STORE_EVALUATIONS=true` 会把评估结果存到 `data/evaluations.json`，公开部署前不要打开，除非已有鉴权和隐私声明。

## 建议业务用法

这个工具不要定位成“自动报价神器”，而是定位成：

> AI 项目售前诊断助手：帮小团队判断客户需求真伪、交付风险、报价策略和是否值得产品化。

推荐成交路径：

0. 保底现金流：启动期优先找 1-2 个能快速回款的小单或诊断/陪跑单，先覆盖月入 2 万。
1. 免费初筛：用客户原话跑一遍。
2. 诊断会：如果信息不足，先收 399-1999 元诊断费。
3. PoC：把大项目拆成 1-3 周可验收试点。
4. 完整交付：只接有明确验收和付款节点的需求。
5. 资产沉淀：把重复需求沉淀成模板、行业方案、组件库和案例。


## 收入阶梯建议

启动期不要直接按月入 50 万设计动作，先按三层目标推进：

- 保底层：月入 2 万，目标是活下来。适合 2 个 1 万小交付、4 个 5000 元诊断/陪跑，或 1 个 2 万 PoC。
- 起步层：月入 5 万，目标是证明成交与交付节奏。适合 1 个 3-5 万项目，加若干诊断费/运维费。
- 放大层：月入 50 万，目标是行业化、产品化、渠道化。需要 5 个 10 万项目，或 2-3 个 20 万以上项目/长期服务包。

工具评估时会同时判断：这个需求是否能帮助覆盖保底现金流，以及是否值得沉淀成可复制资产。

## 后续阶段三建议

- 登录与团队权限。
- 评估记录库与客户 CRM。
- 一键导出 PDF 诊断报告。
- 一键生成报价单、SOW、合同边界。
- 接入飞书/企微/Notion/Obsidian。
- 增加行业模板：教育、知识库客服、内容生产、企业自动化、本地模型部署。
