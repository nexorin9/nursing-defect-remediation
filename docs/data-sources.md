# 公开数据来源与用途

> 本轮真实院内数据不可得。公开数据集**只用于校验与联通**，不进入最终产品路径；
> 最终产品路径是 `docs/api/*.yaml` 的 4 条真实院内协议 + 环境变量凭据位。

## 阶梯与降级

`npm run fetch-data -- --dataset cblue|synthea|all`：先校验本地缓存（文件存在 + 记录数 ≥ 脚本常量阈值 + sha256 与 `CHECKSUMS.txt` 匹配），
通过则跳过下载；否则按数据集独立下载、独立校验；网络失败或校验和不符时打印明确降级原因
（缺哪个数据集、影响哪条能力、后续用哪份本地样例兜底），以**非 0** 退出码结束，不静默失败。
`--offline` 可直接验证断网降级路径。可重复执行：重复运行不产生重复文件、不破坏已有校验和。

## 数据集对照

| 数据集 | 来源 | 许可 | 本轮用途 | 字段对照 | 本地兜底样例 |
|---|---|---|---|---|---|
| CBLUE 中文医疗术语基线 | `CBLUEbenchmark/CBLUE` 仓库中文说明（`README_ZH.md`） | Apache-2.0 | 中文护理术语归一的可比基线 | 中文护理/医疗术语 → `narrative` 同义表述族（滑倒/跌倒/坠床等） | `fixtures/public-fallback/cblue.jsonl` |
| Synthea 事件流骨架 | `synthetichealth/synthea` 的 `src/main/resources/birthweights.csv` | Apache-2.0 | CSV 事件流端到端联通骨架 | 结构化 CSV 行 → `IncidentReport` 的记录粒度与分页水位 | `fixtures/public-fallback/synthea.jsonl` |

CBLUE 的评测数据本体需按官方渠道另行获取，本轮只取仓库中文说明做术语基线联通校验；
Synthea 的 CSV 只用于验证「读文件 → 记录数 → 分页水位」链路，不作为院内上报数据来源。
两者都不含真实患者信息，也不会被打包进桌面应用。

## 合成数据（T4）

`npm run generate` 按 `config/synonyms.json` 配置化生成 1000 条脱敏上报，落 `data/raw/incidents.jsonl`（运行时目录，`.gitignore` 排除）。
自由叙述按同义表述族生成；不生成姓名、住院号、床号、身份证、电话等患者可识别信息。
`fixtures/boundary-incidents.jsonl` 留 20 条边界样例（缺 `encounter_id`、缺 `severity_hint`、超长叙述、生僻字与混编、空叙述等），
是**唯一随仓发布**的样例集。`npm run validate-fixtures` 输出规模报告。
