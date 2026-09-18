"use strict";

/**
 * Netlify Function: 生成医美好评
 *
 * 前端只调用这个接口，DeepSeek 的密钥仅存在于服务端环境变量
 * process.env.DEEPSEEK_API_KEY，不会下发到浏览器。
 *
 * 请求：POST /api/generate
 *   { "projectName": "热玛吉", "institutionName": "某某医疗美容门诊部",
 *     "style": "亲切自然", "length": "中评", "count": 3 }
 * 响应：200 { "reviews": ["好评1", "好评2"] }
 *       500 { "error": "错误信息" }
 */

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

// 单次上游请求的超时时间，避免 Netlify 函数被挂死
const REQUEST_TIMEOUT_MS = 20000;

// 单次最多生成几条，防止被刷
const MAX_COUNT = 5;

// 输入字段的长度上限
const MAX_FIELD_LENGTH = 100;

/* ============ 风格预设 ============ */

const STYLE_PRESETS = {
  亲切自然: {
    tone:
      "语气亲切自然，像和朋友分享这次体验一样，可以带一点生活气息和温度，" +
      "但不要浮夸、不要过度热情、不要写成广告文案。"
  },
  专业严谨: {
    tone:
      "语气专业、严谨、克制，用词准确，侧重客观描述过程和真实感受，" +
      "不煽情、不夸张，也不对效果做任何承诺。"
  },
  活泼简短: {
    tone:
      "语气活泼轻快，多用短句，读起来有节奏感，可以带一点小情绪，" +
      "但不要使用网络流行语或夸张的形容词。"
  },
  精致文艺: {
    tone:
      "语气精致文艺，注重氛围和细节的描写，用词讲究但保持真实的口语感，" +
      "不堆砌辞藻、不做作。"
  }
};

// 同时兼容中文标签和英文 key
const STYLE_ALIASES = {
  亲切自然: "亲切自然",
  专业严谨: "专业严谨",
  活泼简短: "活泼简短",
  精致文艺: "精致文艺",
  warm: "亲切自然",
  pro: "专业严谨",
  lively: "活泼简短",
  artsy: "精致文艺"
};

const DEFAULT_STYLE = "亲切自然";

/* ============ 字数预设 ============ */

const LENGTH_PRESETS = {
  短评: {
    label: "短评",
    min: 40,
    max: 60,
    maxTokens: 260
  },
  中评: {
    label: "中评",
    min: 80,
    max: 120,
    maxTokens: 420
  },
  长评: {
    label: "长评",
    min: 200,
    max: 250,
    maxTokens: 760
  }
};

const LENGTH_ALIASES = {
  短评: "短评",
  中评: "中评",
  长评: "长评",
  short: "短评",
  medium: "中评",
  long: "长评"
};

const DEFAULT_LENGTH = "中评";

/* ============ 多条生成时轮换的角度 ============ */

const ANGLES = [
  "进店、咨询和面诊的整体流程感受",
  "操作过程中的真实体感（比如手法轻重、温度、时长、疼痛感）",
  "术后短期内的变化与恢复过程（比如泛红、消肿、上妆服帖度）",
  "服务细节与机构环境（比如护士的关照、复诊提醒、是否推销）",
  "方案沟通的专业度与自己的心理感受（紧张、安心、被尊重）"
];

/* ============ 工具函数 ============ */

function jsonResponse(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(payload)
  };
}

function resolveStyle(input) {
  if (typeof input !== "string") return DEFAULT_STYLE;
  const key = input.trim();
  return STYLE_ALIASES[key] || DEFAULT_STYLE;
}

function resolveLength(input) {
  if (typeof input !== "string") return DEFAULT_LENGTH;
  const key = input.trim();
  return LENGTH_ALIASES[key] || DEFAULT_LENGTH;
}

function resolveCount(input) {
  const count = parseInt(input, 10);
  if (isNaN(count) || count < 1) {
    return 1;
  }
  return Math.min(count, MAX_COUNT);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

// 去掉模型偶尔带上的引号、序号等外壳
function stripWrapping(text) {
  return text
    .trim()
    .replace(/^\s*(?:第\s*[一二三四五六七八九十\d]+\s*条\s*[：:、.,，]|\d+\s*[.、)])\s*/, "")
    .replace(/^["“'‘]+|["”'’]+$/g, "")
    .trim();
}

// 解析请求体（兼容 base64 编码的情况）
function parseBody(event) {
  const raw = event && event.body;
  if (!raw) return {};

  const text =
    event.isBase64Encoded && typeof Buffer !== "undefined"
      ? Buffer.from(raw, "base64").toString("utf8")
      : raw;

  return JSON.parse(text);
}

/* ============ System Prompt ============ */

function buildSystemPrompt(options) {
  const style = resolveStyle(options.style);
  const length = resolveLength(options.length);
  const lengthPreset = LENGTH_PRESETS[length];
  const angle = options.angle;

  const lines = [
    "你是一位真实的医美消费者，正在大众点评上写一条好评。",
    "",
    "【身份与语气】",
    STYLE_PRESETS[style].tone,
    "",
    "【字数要求】",
    "总字数控制在 " + lengthPreset.min + "-" + lengthPreset.max +
      " 字之间（按中文字符粗略计数，可以略有浮动）。",
    "",
    "【内容要求】",
    "1. 必须自然地提到“" + options.projectName + "”这个项目和“" +
      options.institutionName + "”这家机构，不要生硬堆砌。",
    "2. 以第一人称“我”的口吻来写。",
    "3. 至少包含一个具体的体验细节，比如操作时的感受、术后的变化或恢复过程。",
    "4. 语气自然，像普通顾客随手写的评价，不要写成广告文案。"
  ];

  if (angle) {
    lines.push("5. 这一条请把重点放在：" + angle + "。");
  }

  lines.push(
    "",
    "【禁止事项】",
    "1. 不要出现“最好”“第一”“100%”“根治”“无痛无痕”“永久”“绝对”“无副作用”“包治”“彻底解决”“永不复发”等绝对化或违禁表述。",
    "2. 不要出现任何具体的价格数字、折扣、金额或优惠信息。",
    "3. 不要使用“YYDS”“绝绝子”“天花板”等网络流行语。",
    "4. 不要承诺或暗示确定的医疗效果，也不要出现“保证”“一定有效”这类说法。",
    "",
    "【输出格式】",
    "直接输出这一条好评的正文，不要加标题、序号、引号，也不要做任何解释、说明或前后缀。"
  );

  return lines.join("\n");
}

/* ============ 调用 DeepSeek ============ */

async function callDeepSeek(options) {
  const lengthPreset = LENGTH_PRESETS[options.length];
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(DEEPSEEK_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + options.apiKey
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: options.systemPrompt },
          { role: "user", content: options.userMessage }
        ],
        temperature: 1.2,
        max_tokens: lengthPreset.maxTokens
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      // 只取上游返回的 message，不回传原始响应体，避免任何密钥信息外泄
      let detail = "";
      try {
        const data = await response.json();
        detail = (data && data.error && data.error.message) || "";
      } catch (err) {
        detail = "";
      }

      if (response.status === 401) {
        throw new Error("上游 DeepSeek 鉴权失败，请检查 DEEPSEEK_API_KEY 是否有效。");
      }
      throw new Error(
        "DeepSeek 接口返回 " + response.status + (detail ? "：" + detail : "")
      );
    }

    const data = await response.json();
    const content =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;

    if (!content || !content.trim()) {
      throw new Error("DeepSeek 没有返回内容，请重试。");
    }

    return stripWrapping(content);
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("调用 DeepSeek 超时，请稍后重试。");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ============ 主入口 ============ */

exports.handler = async function (event) {
  // 1) 只接受 POST
  if (!event || event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "只支持 POST 请求。" });
  }

  // 2) 密钥只从环境变量读取
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, {
      error: "服务端未配置 DEEPSEEK_API_KEY，请在 Netlify 的环境变量中设置。"
    });
  }

  // 3) 解析并校验入参
  let payload;
  try {
    payload = parseBody(event);
  } catch (err) {
    return jsonResponse(400, { error: "请求体不是合法的 JSON。" });
  }

  const projectName = normalizeText(payload.projectName);
  const institutionName = normalizeText(payload.institutionName);

  if (!projectName || !institutionName) {
    return jsonResponse(400, {
      error: "projectName 和 institutionName 为必填项。"
    });
  }

  if (
    projectName.length > MAX_FIELD_LENGTH ||
    institutionName.length > MAX_FIELD_LENGTH
  ) {
    return jsonResponse(400, {
      error: "projectName 和 institutionName 的长度不能超过 " + MAX_FIELD_LENGTH + " 个字符。"
    });
  }

  const style = resolveStyle(payload.style);
  const length = resolveLength(payload.length);
  const count = resolveCount(payload.count);

  const userMessage = [
    "项目名称：" + projectName,
    "机构名称：" + institutionName,
    "风格：" + style,
    "字数：" + LENGTH_PRESETS[length].label +
      "（" + LENGTH_PRESETS[length].min + "-" + LENGTH_PRESETS[length].max + " 字）"
  ].join("\n");

  // 4) 逐条生成：count > 1 时循环调用，每条给一个不同的切入角度
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const angle = count > 1 ? ANGLES[i % ANGLES.length] : "";

    tasks.push(
      callDeepSeek({
        apiKey: apiKey,
        projectName: projectName,
        institutionName: institutionName,
        style: style,
        length: length,
        angle: angle,
        systemPrompt: buildSystemPrompt({
          projectName: projectName,
          institutionName: institutionName,
          style: style,
          length: length,
          angle: angle
        }),
        userMessage: angle
          ? userMessage + "\n本条重点角度：" + angle
          : userMessage
      })
    );
  }

  try {
    const reviews = await Promise.all(tasks);

    // 5) 成功返回
    return jsonResponse(200, { reviews: reviews });
  } catch (err) {
    // 6) 统一错误出口，只回传可读信息，不回传密钥或原始响应
    const message = err && err.message ? err.message : "生成失败，请稍后重试。";
    return jsonResponse(500, { error: message });
  }
};
