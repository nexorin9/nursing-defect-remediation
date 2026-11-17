/**
 * 制度条款命中集（T6）。
 *
 * 命中范围只取《医疗质量安全核心制度要点》节录资产（国卫医发〔2018〕8号，
 * 标题为 18 项、实际收录 17 节，缺「二、」）。每条命中带
 * 文件名 + 节次 + 条序 + 原文引句 + 用途标注，只用于**要素提取与缺项提示**，
 * 不输出「符合 / 违规 / 符合规定」一类合规结论，不代替医务科判定。
 *
 * 资产未覆盖的细节（护理缺陷分级枚举、各步处置时限）显式标 (经验推断 · 院内制度待核验)。
 */
export const CLAUSE_ASSET_FILE = "docs/corpus/医疗质量安全核心制度要点节录.md";
/** 原始全文资产名，仅作溯源；项目内节录文件逐条对应其中条款。 */
export const SOURCE_ASSET_NAME = "core_systems_18_医疗质量安全核心制度要点18项全文.txt";

export interface ClauseRef {
  file: string;
  section: string;
  clauseNo: string;
  quote: string;
  excerptSummary: string;
}

export interface ClauseHit extends ClauseRef {
  /** 命中用途：结构化追问项 / 后果参照轴 / 台账依据 / 隐私要求 */
  usage: string;
  /** 资产未覆盖、需院方核验的细节 */
  inferred?: boolean;
  /** 给护士长看的缺项提示（不下结论） */
  missingPrompt: string;
  /** 命中关键词（只用于要素提取，不作语义判定） */
  keywords: string[];
}

export const CLAUSE_HITS: ClauseHit[] = [
  {
    file: CLAUSE_ASSET_FILE,
    section: "十、查对制度",
    clauseNo: "第 2 条",
    quote: "每项医疗行为都必须查对患者身份。应当至少使用两种身份查对方式，严禁将床号作为身份查对的标识。为无名患者进行诊疗活动时，须双人核对。",
    excerptSummary: "身份查对需两种方式，床号不得作为身份标识，无名患者须双人核对",
    usage: "缺陷成因的结构化追问项候选（身份识别方式 / 是否双人 / 是否以床号替代身份）",
    missingPrompt: "请补全：本次操作使用了哪两种身份查对方式，是否双人核对",
    keywords: ["查对", "身份", "床号", "给药核对"],
  },
  {
    file: CLAUSE_ASSET_FILE,
    section: "四、分级护理制度",
    clauseNo: "第 2 条",
    quote: "原则上，护理级别分为特级护理、一级护理、二级护理、三级护理 4 个级别。",
    excerptSummary: "护理级别分四级",
    usage: "缺陷后果的参照轴（是否导致护理级别上调 / 非预期住院）",
    missingPrompt: "请补全：缺陷发生后护理级别是否调整",
    keywords: ["分级护理", "护理级别", "级别上调"],
  },
  {
    file: CLAUSE_ASSET_FILE,
    section: "五、值班和交接班制度",
    clauseNo: "第 8 条",
    quote: "交接班内容应当专册记录，并由交班人员和接班人员共同签字确认。",
    excerptSummary: "交接班专册记录并双方签字",
    usage: "交接班环节缺陷的命中项候选，是护理部现有台账的制度依据",
    missingPrompt: "请补全：交接班专册记录号与双方签字情况",
    keywords: ["交接班", "交班", "接班", "漏项"],
  },
  {
    file: CLAUSE_ASSET_FILE,
    section: "十四、危急值报告制度",
    clauseNo: "第 3 条",
    quote: "出现危急值时，出具检查、检验结果报告的部门报出前，应当双人核对并签字确认。",
    excerptSummary: "危急值报出前双人核对签字",
    usage: "危急值相关护理缺陷（漏报 / 漏记录）对应条款",
    missingPrompt: "请补全：危急值接收、复读与记录时间",
    keywords: ["危急值", "漏报", "漏记录"],
  },
  {
    file: CLAUSE_ASSET_FILE,
    section: "十四、危急值报告制度",
    clauseNo: "第 5 条",
    quote: "临床科室任何接收到危急值信息的人员应当准确记录、复读、确认危急值结果。",
    excerptSummary: "接收危急值须准确记录、复读、确认",
    usage: "危急值记录链路的缺项提示",
    missingPrompt: "请补全：复读与确认的执行人",
    keywords: ["危急值", "复读", "确认"],
  },
  {
    file: CLAUSE_ASSET_FILE,
    section: "十八、信息安全管理制度",
    clauseNo: "第 5 条",
    quote: "使用患者诊疗信息应当遵循合法、依规、正当、必要的原则。",
    excerptSummary: "患者诊疗信息使用遵循合法依规正当必要",
    usage: "缺陷叙述含患者可识别信息 → 窗口与台账默认脱敏",
    missingPrompt: "请确认：叙述中是否已去除患者可识别信息",
    keywords: ["隐私", "患者信息", "脱敏"],
  },
  {
    file: CLAUSE_ASSET_FILE,
    section: "十八、信息安全管理制度",
    clauseNo: "第 6 条",
    quote: "应当建立员工授权管理制度，明确员工的患者诊疗信息使用权限和相关责任。",
    excerptSummary: "建立员工授权与信息使用权限责任",
    usage: "导出件不含患者标识、审计留痕但不落敏感正文",
    missingPrompt: "请确认：导出范围的授权依据",
    keywords: ["授权", "导出", "权限"],
  },
];

/** 资产缺口：不得绕过，必须显式标注。 */
export const ASSET_GAPS: { item: string; reason: string; label: string }[] = [
  {
    item: "护理缺陷分级枚举",
    reason: "domain 资产层无护理缺陷分级文件，核心制度全文检索「不良事件」0 命中",
    label: "(经验推断 · 院内制度待核验)",
  },
  {
    item: "各步处置时限与催办时刻",
    reason: "核心制度全文未规定护理缺陷处置时限，domain/rules 与 dictionaries 亦无条目",
    label: "(经验推断 · 院内制度待核验)",
  },
];

/** 合规结论词：命中集输出中出现任一即视为越界（由测试守住）。 */
export const CONCLUSION_WORDS = ["符合规定", "符合制度", "违规", "不合规", "合格", "判定为合规"];

/** 按关键词命中条款；只做要素提取，不做语义判定。 */
export function findClauseHits(text: string): ClauseHit[] {
  return CLAUSE_HITS.filter((hit) => hit.keywords.some((k) => text.includes(k)));
}

/** 渲染成给护士长看的文本；明确只提示缺项、不下结论。 */
export function renderClauseHits(hits: ClauseHit[]): string {
  const lines = hits.map(
    (h) => `依据 ${h.file} · ${h.section} ${h.clauseNo}：${h.excerptSummary}；${h.missingPrompt}（${h.usage}）`,
  );
  lines.push(...ASSET_GAPS.map((g) => `资产缺口：${g.item} ${g.label}，原因：${g.reason}`));
  return lines.join("\n");
}

/** 命中集输出是否含合规结论词（守门层与测试共用）。 */
export function containsConclusion(text: string): boolean {
  return CONCLUSION_WORDS.some((w) => text.includes(w));
}
