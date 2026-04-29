import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'evaluations.json');

await loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8787);
const requestBucket = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 60;

async function loadDotEnv(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env is optional. .env.example documents required values.
  }
}

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function textResponse(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(text);
}

function rateLimit(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = requestBucket.get(ip) || { start: now, count: 0 };
  if (now - bucket.start > RATE_LIMIT_WINDOW_MS) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  requestBucket.set(ip, bucket);
  if (bucket.count > RATE_LIMIT_MAX) {
    jsonResponse(res, 429, { error: '请求过于频繁，请稍后再试。' });
    return false;
  }
  return true;
}

async function readJsonBody(req, maxBytes = 512 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('请求体过大。');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON。');
  }
}

async function parseMultipart(req, boundary, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('上传内容过大。');
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  const boundaryBuf = Buffer.from('--' + boundary);
  const doubleCrlf = Buffer.from('\r\n\r\n');
  const fields = {};
  const files = {};

  let pos = buffer.indexOf(boundaryBuf);
  if (pos < 0) return { fields, files };

  while (pos < buffer.length) {
    pos += boundaryBuf.length;
    if (pos + 2 <= buffer.length && buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break;
    if (pos + 2 <= buffer.length && buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;

    const headerEnd = buffer.indexOf(doubleCrlf, pos);
    if (headerEnd < 0) break;
    const headerText = buffer.slice(pos, headerEnd).toString('utf8');
    pos = headerEnd + 4;

    const nextBoundary = buffer.indexOf(boundaryBuf, pos);
    let body;
    if (nextBoundary < 0) {
      body = buffer.slice(pos);
      pos = buffer.length;
    } else {
      let bodyEnd = nextBoundary;
      if (bodyEnd >= 2 && buffer[bodyEnd - 2] === 0x0d && buffer[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
      body = buffer.slice(pos, bodyEnd);
      pos = nextBoundary;
    }

    const nameMatch = headerText.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    const filenameMatch = headerText.match(/filename="([^"]*)"/);
    if (filenameMatch && filenameMatch[1]) {
      files[name] = {
        filename: filenameMatch[1],
        contentType: (headerText.match(/Content-Type:\s*(\S+)/i) || [])[1] || 'application/octet-stream',
        buffer: body,
        size: body.length
      };
    } else {
      fields[name] = body.toString('utf8');
    }
  }

  return { fields, files };
}

function extractDocxText(buffer) {
  try {
    let pos = 0;
    while (pos < buffer.length - 4) {
      if (buffer[pos] !== 0x50 || buffer[pos + 1] !== 0x4b || buffer[pos + 2] !== 0x03 || buffer[pos + 3] !== 0x04) {
        pos++;
        continue;
      }
      const filenameLen = buffer.readUInt16LE(pos + 26);
      const extraLen = buffer.readUInt16LE(pos + 28);
      const filename = buffer.slice(pos + 30, pos + 30 + filenameLen).toString('utf8');
      const dataStart = pos + 30 + filenameLen + extraLen;

      if (filename === 'word/document.xml') {
        const compMethod = buffer.readUInt16LE(pos + 8);
        const compSize = buffer.readUInt32LE(pos + 18);
        const compressed = buffer.slice(dataStart, dataStart + compSize);

        let xml;
        if (compMethod === 0) {
          xml = compressed.toString('utf8');
        } else if (compMethod === 8) {
          xml = zlib.inflateRawSync(compressed).toString('utf8');
        } else {
          return '[DOCX 文件使用了不支持的压缩算法]';
        }

        let text = xml
          .replace(/<w:p[ >]/g, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
        text = text.replace(/\n{3,}/g, '\n\n').replace(/ +/g, ' ').trim();
        return text || '[DOCX 文件中未找到文本内容]';
      }
      pos = dataStart;
    }
    return '[DOCX 文件中未找到 word/document.xml]';
  } catch (e) {
    return `[DOCX 文件解析失败：${e.message}]`;
  }
}

function extractPdfText(buffer) {
  try {
    const texts = [];
    const extractBTET = (content) => {
      const str = typeof content === 'string' ? content : content.toString('latin1');
      const btRegex = /BT([\s\S]*?)ET/g;
      let match;
      while ((match = btRegex.exec(str)) !== null) {
        const block = match[1];
        const tjRegex = /\(([^)]*)\)\s*Tj/g;
        let tm;
        while ((tm = tjRegex.exec(block)) !== null) {
          const t = tm[1].replace(/\\([()\\nrtbf])/g, (_, c) =>
            c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c);
          if (t.trim()) texts.push(t);
        }
        const tjArrRegex = /\[([^\]]*)\]\s*TJ/g;
        let ta;
        while ((ta = tjArrRegex.exec(block)) !== null) {
          const strRegex = /\(([^)]*)\)/g;
          let sm;
          while ((sm = strRegex.exec(ta[1])) !== null) {
            const t = sm[1].replace(/\\([()\\nrtbf])/g, (_, c) =>
              c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c);
            if (t.trim()) texts.push(t);
          }
        }
      }
    };

    // Try uncompressed content first
    extractBTET(buffer.toString('latin1'));

    // Try FlateDecode streams
    let pos = 0;
    while (pos < buffer.length - 6) {
      const ss = buffer.indexOf('stream', pos);
      if (ss < 0) break;
      let ds = ss + 6;
      if (ds < buffer.length && buffer[ds] === 0x0d) ds++;
      if (ds < buffer.length && buffer[ds] === 0x0a) ds++;

      const se = buffer.indexOf('endstream', ds);
      if (se < 0) break;
      let de = se;
      if (de > ds && buffer[de - 1] === 0x0a) de--;
      if (de > ds && buffer[de - 1] === 0x0d) de--;

      const dictStart = Math.max(0, ss - 300);
      const dictText = buffer.slice(dictStart, ss).toString('latin1');

      if (dictText.includes('/FlateDecode') || dictText.includes('/Fl')) {
        try {
          const decompressed = zlib.inflateRawSync(buffer.slice(ds, de));
          extractBTET(decompressed.toString('latin1'));
        } catch {}
      }
      pos = se + 9;
    }

    if (!texts.length) return '[PDF 文件中未找到可提取的文本层，可能是扫描件或纯图片 PDF]';
    return texts.join(' ').replace(/\s+/g, ' ').trim();
  } catch (e) {
    return `[PDF 文件解析失败：${e.message}]`;
  }
}

function extractFileText(file, maxChars = 10000) {
  const ext = path.extname(file.filename).toLowerCase();

  if (ext === '.docx') {
    const raw = extractDocxText(file.buffer);
    return raw.length > maxChars ? raw.slice(0, maxChars) + '\n…[内容已截断]' : raw;
  }
  if (ext === '.pdf') {
    const raw = extractPdfText(file.buffer);
    return raw.length > maxChars ? raw.slice(0, maxChars) + '\n…[内容已截断]' : raw;
  }
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp' || ext === '.bmp') {
    return `[图片文件 "${file.filename}" — 图片内容无法自动提取为文本。请将图片中的关键信息手动描述在需求输入框中，或使用支持多模态视觉的模型。]`;
  }

  const textExts = new Set([
    '.txt', '.md', '.markdown', '.json', '.csv', '.yaml', '.yml',
    '.xml', '.html', '.htm', '.log', '.env', '.cfg', '.ini', '.toml',
    '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.c',
    '.cpp', '.h', '.css', '.scss', '.less', '.sql', '.sh', '.bash',
    '.ps1', '.proto', '.graphql', '.doc', '.ppt', '.pptx', '.xls', '.xlsx'
  ]);
  if (!textExts.has(ext)) {
    return `[文件 "${file.filename}" (${ext}) 的类型不支持自动文本提取，请手动粘贴关键内容到需求描述中]`;
  }
  try {
    let text = file.buffer.toString('utf8');
    text = text.replace(/ /g, '');
    return text.length > maxChars ? text.slice(0, maxChars) + '\n…[内容已截断]' : text;
  } catch {
    return `[文件 "${file.filename}" 的文本编码无法识别]`;
  }
}

async function parseRequestBody(req, maxBytes) {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    const m = contentType.match(/boundary=(.+?)(;|$)/);
    if (!m) throw new Error('multipart 缺少 boundary。');
    const boundary = m[1].replace(/^["']|["']$/g, '');
    return parseMultipart(req, boundary, maxBytes);
  }
  const jsonBody = await readJsonBody(req, maxBytes);
  return { fields: jsonBody, files: {} };
}

function envConfig() {
  return {
    provider: process.env.MODEL_PROVIDER || 'openai-compatible',
    apiUrl: process.env.MODEL_API_URL || 'https://api.deepseek.com/chat/completions',
    apiKey: process.env.MODEL_API_KEY || '',
    model: process.env.MODEL_NAME || 'deepseek-chat'
  };
}

function getBusinessDefaults() {
  return {
    baselineMonthlyTarget: Number(process.env.BASELINE_MONTHLY_TARGET || 20000),
    earlyMonthlyTarget: Number(process.env.EARLY_MONTHLY_TARGET || 50000),
    targetMonthlyRevenue: Number(process.env.TARGET_MONTHLY_REVENUE || 500000),
    annualRevenueTarget: Number(process.env.ANNUAL_REVENUE_TARGET || 6000000),
    teamSize: process.env.TEAM_SIZE || '2-3'
  };
}

function cleanText(value, max = 6000) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, max);
}

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeBusinessGoal(input = {}) {
  const defaults = getBusinessDefaults();
  return {
    baselineMonthlyTarget: safeNumber(input.baselineMonthlyTarget, defaults.baselineMonthlyTarget),
    earlyMonthlyTarget: safeNumber(input.earlyMonthlyTarget, defaults.earlyMonthlyTarget),
    targetMonthlyRevenue: safeNumber(input.targetMonthlyRevenue, defaults.targetMonthlyRevenue),
    annualRevenueTarget: safeNumber(input.annualRevenueTarget, defaults.annualRevenueTarget),
    teamSize: cleanText(String(input.teamSize || defaults.teamSize), 30) || defaults.teamSize
  };
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const firstObj = raw.indexOf('{');
    const lastObj = raw.lastIndexOf('}');
    const firstArr = raw.indexOf('[');
    const lastArr = raw.lastIndexOf(']');
    const objCandidate = firstObj >= 0 && lastObj > firstObj ? raw.slice(firstObj, lastObj + 1) : '';
    const arrCandidate = firstArr >= 0 && lastArr > firstArr ? raw.slice(firstArr, lastArr + 1) : '';
    const candidate = objCandidate || arrCandidate;
    if (!candidate) throw new Error('模型没有返回可解析的 JSON。');
    return JSON.parse(candidate);
  }
}

async function callLLM(messages, systemPrompt, { maxTokens = 3200, temperature = 0.25 } = {}) {
  const config = envConfig();
  if (!config.apiKey || config.apiKey.includes('replace-with')) {
    throw new Error('后端未配置 MODEL_API_KEY，请复制 .env.example 为 .env 并填写服务端 API Key。');
  }

  const isAnthropic = config.provider === 'anthropic' || config.apiUrl.includes('anthropic.com');
  const startedAt = Date.now();
  let response;

  if (isAnthropic) {
    response = await fetch(config.apiUrl || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages
      })
    });
  } else {
    const payload = {
      model: config.model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: maxTokens,
      temperature
    };
    // Some OpenAI-compatible providers support JSON mode; some do not. If unsupported, remove this line.
    payload.response_format = { type: 'json_object' };

    response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(payload)
    });
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`模型接口失败：${response.status} ${responseText.slice(0, 500)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error(`模型接口返回非 JSON：${responseText.slice(0, 500)}`);
  }

  const content = isAnthropic
    ? (parsed.content || []).map(item => item.text || '').join('')
    : parsed.choices?.[0]?.message?.content;

  if (!content) throw new Error('模型接口没有返回内容。');
  return { content, latencyMs: Date.now() - startedAt, model: config.model, provider: config.provider };
}

function buildQuestionPrompt() {
  return `你是 AI 定制项目的售前需求分析专家，服务对象是 2-3 人的小团队。你的任务是根据客户需求，生成 4-6 个必须追问的问题，用来判断：需求真实度、预算能力、决策链路、交付难度、验收标准、复购/产品化潜力。

如果客户提供了附件文档，它可能包含：需求文档、技术方案、会议纪要、产品说明等。请结合文档内容生成追问。

要求：
- 问题要直接，不要客套。
- 每个问题都要能帮助判断是否值得继续推进。
- 优先追问缺失信息，不要重复客户已经说清楚的内容（包括文档中已有的信息）。
- 如果附件文档已经覆盖了某些方面，针对文档未覆盖或模糊的部分继续深挖。
- 只返回 JSON 对象，不要 Markdown，不要解释。

返回格式：
{
  "questions": [
    {"id":"q1","category":"预算/决策/痛点/数据/交付/验收/增长", "question":"问题内容", "placeholder":"客户可能回答示例", "why":"为什么要问"}
  ]
}`;
}

function buildEvaluationPrompt(goal) {
  return `你是 AI 项目售前评估负责人，帮助 2-3 人小团队判断一个 AI 定制/AI 工作流/AI 智能体/FDE 项目是否值得接。团队业务目标：保底团队月收入 ${goal.baselineMonthlyTarget} 元，起步团队月收入 ${goal.earlyMonthlyTarget} 元，最终月收入 ${goal.targetMonthlyRevenue} 元，年收入 ${goal.annualRevenueTarget} 元，团队规模 ${goal.teamSize} 人。

如果客户提供了附件文档（需求文档/技术方案/会议纪要等），请将文档内容作为评估的核心依据，结合需求描述和追问回答综合判断。

你必须用商业化、交付、风险三条线评估，不要给泛泛建议。

评分框架：
1. 真实需求度 0-100：痛点强度、预算明确度、决策人/付款人、是否已立项、紧迫度。
2. 可交付度 0-100：数据/资料准备、系统接口、技术复杂度、验收标准、客户配合度。
3. 变现质量 0-100：客单价、回款确定性、复购可能、案例价值、产品化价值。
4. 目标匹配度 0-100：这个项目是否先能覆盖保底 2 万现金流，再支持团队从月入 5 万走向月入 50 万。

红线判断：
- 无预算却要完整系统；
- 只愿意分成，不愿意付前期费用；
- 没数据但要求高准确率；
- 复杂系统要求极短周期上线；
- 需求涉及医疗/金融/隐私/合规但责任边界不清；
- 客户没有决策权或一直转述老板想法；
- 验收标准是“像某大厂一样智能”但没有业务指标。

你必须返回严格 JSON 对象，不要 Markdown，不要额外文字。

返回格式：
{
  "summary": "一句话判断",
  "decision": "接|谨慎接|不接|先收诊断费",
  "decisionReason": "2-4句，说明为什么",
  "scores": {
    "realNeed": {"score": 0, "reason": ""},
    "deliverability": {"score": 0, "reason": ""},
    "monetization": {"score": 0, "reason": ""},
    "goalFit": {"score": 0, "reason": ""}
  },
  "redFlags": [
    {"level":"高|中|低", "title":"红线名称", "detail":"具体风险", "mitigation":"如何化解"}
  ],
  "missingInfo": ["仍缺失的信息"],
  "delivery": {
    "recommendedScope": "建议交付边界",
    "mvpPlan": ["第1阶段", "第2阶段", "第3阶段"],
    "timeline": "周期",
    "teamRoles": ["角色1", "角色2"],
    "techPath": "建议技术路径",
    "acceptanceCriteria": ["验收标准1", "验收标准2"],
    "afterSalesBoundary": "售后边界"
  },
  "pricing": {
    "diagnosisFee": "诊断费建议",
    "pocPrice": "PoC/试点报价建议",
    "projectPrice": "完整项目报价建议",
    "paymentPlan": "付款节点建议",
    "lowPriceWarning": "低价接单风险"
  },
  "salesAction": {
    "nextMove": "下一步动作",
    "customerMessage": "可以直接发给客户的一段话",
    "meetingAgenda": ["会议议程1", "会议议程2"],
    "documentsToAsk": ["需客户提供材料1", "需客户提供材料2"]
  },
  "businessGoalFit": {
    "baselineMonthlyTarget": ${goal.baselineMonthlyTarget},
    "earlyMonthlyTarget": ${goal.earlyMonthlyTarget},
    "targetMonthlyRevenue": ${goal.targetMonthlyRevenue},
    "annualRevenueTarget": ${goal.annualRevenueTarget},
    "dealMath": "按照建议客单价，要达成保底2万/月入5万/月入50万分别需要多少单或多少复购",
    "baselineSurvivalPlan": "启动期如何用这个项目或同类项目覆盖月入2万保底现金流，包括最低客单价、最低成交数量、交付节奏",
    "recommendedOffer": "为了从保底2万逐步走向月入50万，该需求应该被包装成什么标准化服务/产品",
    "scalingBottleneck": "2-3人团队放大的最大瓶颈",
    "repeatableAssets": ["可沉淀资产1", "可沉淀资产2"],
    "notWorthScalingReason": "如果不适合规模化，说明原因；如果适合，填空字符串"
  }
}`;
}

async function persistEvaluation(record) {
  if (String(process.env.STORE_EVALUATIONS || 'false').toLowerCase() !== 'true') return;
  try {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const raw = await fs.readFile(DATA_FILE, 'utf8').catch(() => '[]');
    const list = JSON.parse(raw || '[]');
    list.unshift(record);
    await fs.writeFile(DATA_FILE, JSON.stringify(list.slice(0, 200), null, 2), 'utf8');
  } catch (error) {
    console.error('Persist evaluation failed:', error);
  }
}

async function handleHealth(_req, res) {
  const config = envConfig();
  jsonResponse(res, 200, {
    ok: true,
    provider: config.provider,
    model: config.model,
    apiConfigured: Boolean(config.apiKey && !config.apiKey.includes('replace-with')),
    apiUrlHost: (() => {
      try { return new URL(config.apiUrl).host; } catch { return 'invalid-url'; }
    })(),
    businessDefaults: getBusinessDefaults(),
    storageEnabled: String(process.env.STORE_EVALUATIONS || 'false').toLowerCase() === 'true'
  });
}

async function handleQuestions(req, res) {
  const { fields, files } = await parseRequestBody(req);
  const demand = cleanText(fields?.demand, 7000);
  const context = cleanText(fields?.context, 2000);
  const fileText = files?.file ? extractFileText(files.file) : '';

  if (!fileText && demand.length < 10) return jsonResponse(res, 400, { error: '需求描述太短，请至少补充客户是谁、想解决什么问题。' });
  if (fileText && demand.length < 2) return jsonResponse(res, 400, { error: '请补充需求描述，说明评估目标。' });

  let userContent = '';
  if (fileText) {
    userContent += `客户提供的附件文档 (${files.file.filename}) 内容：\n${fileText}\n\n`;
  }
  userContent += `客户需求描述：\n${demand}\n\n已知商业背景：\n${context || '未提供'}`;

  const { content, latencyMs, model, provider } = await callLLM([
    { role: 'user', content: userContent }
  ], buildQuestionPrompt(), { maxTokens: 1800, temperature: 0.2 });

  const json = extractJson(content);
  const questions = Array.isArray(json) ? json : json.questions;
  if (!Array.isArray(questions)) throw new Error('追问结果格式错误。');
  jsonResponse(res, 200, { questions: questions.slice(0, 6), meta: { latencyMs, model, provider } });
}

function parseFieldJson(raw, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function handleEvaluate(req, res) {
  const { fields, files } = await parseRequestBody(req);
  const demand = cleanText(fields?.demand, 8000);
  const context = cleanText(fields?.context, 3000);
  const answersRaw = parseFieldJson(fields?.answers, []);
  const answers = (Array.isArray(answersRaw) ? answersRaw : []).map(item => ({
    question: cleanText(item.question, 500),
    answer: cleanText(item.answer, 1500)
  }));
  const goal = normalizeBusinessGoal(parseFieldJson(fields?.goal, {}));
  const fileText = files?.file ? extractFileText(files.file) : '';

  if (!fileText && demand.length < 10) return jsonResponse(res, 400, { error: '需求描述太短，无法评估。' });

  const answerText = answers
    .filter(item => item.question || item.answer)
    .map((item, index) => `${index + 1}. 问：${item.question || '未记录问题'}\n答：${item.answer || '未回答'}`)
    .join('\n\n') || '客户未补充回答。';

  let userContent = '';
  if (fileText) {
    userContent += `客户提供的附件文档 (${files.file.filename}) 内容：\n${fileText}\n\n`;
  }
  userContent += `原始需求：\n${demand}\n\n商业背景：\n${context || '未提供'}\n\n追问回答：\n${answerText}`;

  const { content, latencyMs, model, provider } = await callLLM([
    { role: 'user', content: userContent }
  ], buildEvaluationPrompt(goal), { maxTokens: 4200, temperature: 0.18 });

  const result = extractJson(content);
  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    demandPreview: demand.slice(0, 120),
    contextPreview: context.slice(0, 120),
    result,
    meta: { latencyMs, model, provider, goal }
  };
  await persistEvaluation(record);
  jsonResponse(res, 200, { result, meta: record.meta, id: record.id });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

async function serveStatic(req, res, pathname) {
  let safePath = decodeURIComponent(pathname);
  if (safePath === '/') safePath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return textResponse(res, 403, 'Forbidden');
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  } catch {
    textResponse(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      if (!rateLimit(req, res)) return;
      if (req.method === 'GET' && pathname === '/api/health') return handleHealth(req, res);
      if (req.method === 'POST' && pathname === '/api/questions') return handleQuestions(req, res);
      if (req.method === 'POST' && pathname === '/api/evaluate') return handleEvaluate(req, res);
      return jsonResponse(res, 404, { error: 'Not found' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return textResponse(res, 405, 'Method not allowed');
    return serveStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    jsonResponse(res, 500, { error: error.message || '服务器错误。' });
  }
});

server.listen(PORT, () => {
  console.log(`Demand Evaluator Stage 2 running at http://localhost:${PORT}`);
});
