# Benchmark 工具（VSRG-DanEstimation-Benchmark）

把本仓库的读数跑进 [VSRG-DanEstimation-Benchmark](https://github.com/AkutaZehy/VSRG-DanEstimation-Benchmark)
（776 张人工标定的段位谱，Reform 数值刻度）并生成对比报告。按顺序跑：

| 步骤 | 命令 | 产物 |
|---|---|---|
| 1. 打分 | `node score.mjs --rows --shard 0 --nshards 8 --out scores-shard0.json`（8 份并行更快） | `scores-shard*.json` |
| 1b. 锚点谱 | `node score.mjs --anchors --out anchors.json` | `anchors.json`（files/ 里 4 张锚点谱的读数） |
| 2. 特征 | `node feats.mjs` | `feats.json`（每行的 jack180 / ln_frac） |
| 3. 映射 | `node map.mjs` | 写入 `<bench>/results/`：`SkyP1H.csv`、`SkyP1H-jackBuffed.csv`、`index.json` |
| 4. 报告 | `python build_report.py` | `benchmark-report.html`（本目录，可用 `$REPORT_OUT` 覆盖） |

数据集位置：`--bench <dir>` > 环境变量 `BENCH_DIR` > 默认推断（仓库上一级的
`VSRG-DanEstimation-Benchmark-main`）。锚点谱目录：`--files <dir>`，默认 `<bench>/../files`。
`map.mjs` 与 `build_report.py` 读同目录下的中间产物（`anchors.json`、`feats.json`、`mapped-*.json`），
请从本目录运行。

依赖：Node + 仓库根目录的 `onnxruntime-web`（`npm i`）；报告脚本只用 Python 3 标准库。
打分遵守 benchmark `docs/runner.md` 的约定（rate 固定 1.0、名字匹配 exact → normalized → Name(...)、
只覆盖 got/delta/deltaAbs）；映射规则（REFORM 3rd 替代锚、jack 修正曲线）见 `map.mjs` 头部注释。

本目录 `results/` 存本次 P1H 运行的三份输出副本（`SkyP1H.csv` / `SkyP1H-jackBuffed.csv` /
`TreeStar-rf3.csv`，即 `../tree-star-benchmark-report.html` 报告所依据的完整数据）；同一套文件已注册在
VSRG-DanEstimation-Benchmark 仓库的 `results/` 下。
