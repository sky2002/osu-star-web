# Build single-file HTML comparison report for the sky/P1H benchmark run.
# Embeds: overall/pattern/bin stats, anchor tiers, jackShare error analysis, per-row table, SVG scatters.
# Usage: python build_report.py [<bench dir>]   (> $BENCH_DIR > sibling of the repo checkout)
# Reads the results CSVs from <bench>/results and mapped-*.json from this directory (written by map.mjs);
# writes benchmark-report.html here (override with $REPORT_OUT).
import csv, json, math, html, os, statistics, sys, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.environ.get('BENCH_DIR') or (sys.argv[1] if len(sys.argv) > 1 else os.path.abspath(os.path.join(HERE, '..', '..', '..', 'VSRG-DanEstimation-Benchmark-main')))
RUNNER = HERE   # mapped-debug.json / mapped-rows.json written here by map.mjs
OUT = os.environ.get('REPORT_OUT') or os.path.join(HERE, 'benchmark-report.html')
ALGOS = ['Sunny', 'Daniel', 'Azusa', 'Roxy', 'Companella', 'DanOverlay', 'Mixed', 'SkyP1H', 'SkyP1H-jackBuffed']
DISPLAY = {'SkyP1H': 'sky/P1H', 'SkyP1H-jackBuffed': 'sky/P1H-jackBuffed'}
PATS = ['course', 'speed', 'stamina', 'tech', 'jack', 'ln']
BINS = [(1, 4), (4, 8), (8, 11), (11, 15), (15, 17), (17, 18.5)]

def load(algo):
    out = []
    for r in csv.DictReader(open(os.path.join(BENCH, 'results', algo + '.csv'), encoding='utf-8')):
        try:
            out.append((r['pattern'], r['name'], float(r['expected']), float(r['got'])))
        except ValueError:
            pass
    return out

data = {a: load(a) for a in ALGOS}

def stats(ds):
    if not ds: return None
    return dict(n=len(ds), mae=sum(abs(d) for d in ds) / len(ds),
                rmse=math.sqrt(sum(d * d for d in ds) / len(ds)), bias=sum(ds) / len(ds))

overall = {a: stats([e - g for _, _, e, g in data[a]]) for a in ALGOS}
by_pat = {a: {p: stats([e - g for pt, _, e, g in data[a] if pt == p]) for p in PATS} for a in ALGOS}
by_bin = {a: [stats([e - g for _, _, e, g in data[a] if b1 <= e < b2]) for b1, b2 in BINS] for a in ALGOS}

debug = json.load(open(os.path.join(RUNNER, 'mapped-debug.json'), encoding='utf-8'))
rows = json.load(open(os.path.join(RUNNER, 'mapped-rows.json'), encoding='utf-8'))
ref_rows = {(pt, n): (e, g) for pt, n, e, g in data['Azusa']}
sunny_rows = {(pt, n): (e, g) for pt, n, e, g in data['Sunny']}
fit = debug['fit']

per_row = []
for r in rows:
    try:
        gA, gB = float(r['got']), float(r['buffed'])
        e = float(r['expected'])
    except (KeyError, ValueError):
        continue
    per_row.append(dict(n=r['name'], p=r['pattern'], sub=r['subPattern'], e=e,
                        a=gA, b=gB, j=r.get('jack180'), ln=r.get('ln_frac'),
                        rel=r.get('reliable'),
                        s=sunny_rows.get((r['pattern'], r['name']), (None, None))[1],
                        z=ref_rows.get((r['pattern'], r['name']), (None, None))[1]))

# binned mean relative error (%) pre/post buff, on rice rows, over the fitted bins
rice = [r for r in per_row if r['j'] is not None and r['ln'] is not None and r['ln'] < fit['lnMax']]
bin_curves = []
for b in fit['bins']:
    rs = [r for r in rice if b['lo'] <= r['j'] < b['hi']]
    if not rs: continue
    pre = sum((r['e'] - r['a']) / r['e'] * 100 for r in rs) / len(rs)
    post = sum((r['e'] - r['b']) / r['e'] * 100 for r in rs) / len(rs)
    bin_curves.append(dict(c=b['center'], pre=pre, post=post, n=len(rs), lo=b['lo'], hi=b['hi']))

tiers = debug['tiers']
lnTiers = debug['lnTiers']

# LN side: before/after by expected bin on ln rows with e>=5
ln_scope = [r for r in per_row if r['ln'] is not None and r['ln'] >= fit['lnMax'] and r['e'] >= 5]
ln_bin_rows = ''
for lo, hi in [(5, 8), (8, 11), (11, 15), (15, 19)]:
    rs = [r for r in ln_scope if lo <= r['e'] < hi]
    if not rs: continue
    pre = [r['e'] - r['a'] for r in rs]; post = [r['e'] - r['b'] for r in rs]
    ln_bin_rows += (f'<tr><td>{lo}–{hi}</td><td>{len(rs)}</td>'
                    f'<td>{sum(pre)/len(pre):+.2f}</td><td>{sum(map(abs,pre))/len(pre):.2f}</td>'
                    f'<td>{sum(post)/len(post):+.2f}</td><td>{sum(map(abs,post))/len(post):.2f}</td></tr>')
lnfit_rows = ''.join(f'<tr><td class="l">lnPos∈[{b["lo"]:.1f},{b["hi"]:.1f})</td><td>{b["n"]}</td><td>{b["bias"]:+.3f}</td></tr>'
                     for b in debug['lnFit']['bins'])
lntier_rows = ''.join(f'<tr><td class="l">LN {("-".join(str(m) for m in t["members"])) if t["merged"] else t["members"][0]}</td>'
                      f'<td>{t["pos"]:.1f}</td><td>{t["star"]:.3f}</td><td class="l">{"合并" if t["merged"] else ""}</td></tr>'
                      for t in lnTiers)
ho = fit['holdout']
lho = debug['lnFit']['holdout']

def esc(s): return html.escape(str(s))

def stat_cell(s, key, digits=3):
    return '%.*f' % (digits, s[key]) if s else '–'

now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')

css = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font-family: system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif; margin: 0; color: #1a1a1a; background: #fafafa; line-height: 1.55; }
main { max-width: 1080px; margin: 0 auto; padding: 24px 20px 80px; }
h1 { font-size: 22px; margin: 8px 0 4px; }
h2 { font-size: 17px; margin: 36px 0 10px; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
.meta { color: #666; font-size: 13px; }
table { border-collapse: collapse; font-size: 13.5px; margin: 10px 0; width: 100%; background: #fff; }
th, td { border: 1px solid #e2e2e2; padding: 5px 9px; text-align: right; }
th:first-child, td:first-child { text-align: left; }
th { background: #f0f0f0; font-weight: 600; }
tr.ours td:first-child { font-weight: 600; }
tr.ours { background: #f2f8f2; }
td.l { text-align: left; }
.small { font-size: 12.5px; color: #555; }
.note { background: #fff8e6; border: 1px solid #eedc9a; border-radius: 6px; padding: 10px 14px; font-size: 13.5px; margin: 12px 0; }
.finding { margin: 8px 0; }
svg { background: #fff; border: 1px solid #e2e2e2; }
.scatterwrap { display: flex; flex-wrap: wrap; gap: 14px; }
input, select { font: inherit; padding: 4px 8px; border: 1px solid #bbb; border-radius: 4px; }
.filters { display: flex; gap: 10px; margin: 8px 0; flex-wrap: wrap; }
details { margin: 10px 0; }
summary { cursor: pointer; font-weight: 600; padding: 6px 0; }
.dneg { color: #8a4b08; } .dpos { color: #14532d; }
.bad { background: #fde8e8; } .good { background: #e5f5e5; }
.legend { font-size: 12.5px; color: #444; margin: 4px 0; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 4px 0 12px; vertical-align: -1px; }
"""

js = """
const ROWS = %s;
const JACKCURVE = %s;
const fmt = x => x.toFixed(2);
function renderTable() {
  const q = document.getElementById('q').value.toLowerCase();
  const p = document.getElementById('pat').value;
  const tbody = document.getElementById('rows');
  const frag = [];
  for (const r of ROWS) {
    if (p !== 'all' && r.p !== p) continue;
    if (q && !(r.n.toLowerCase().includes(q) || r.sub.toLowerCase().includes(q))) continue;
    const dA = r.e - r.a, dB = r.e - r.b;
    const cls = d => Math.abs(d) >= 1 ? 'bad' : Math.abs(d) <= 0.2 ? 'good' : '';
    frag.push(`<tr><td class="l">${r.n}</td><td>${r.p}</td><td class="l">${r.sub}</td>` +
      `<td>${fmt(r.e)}</td><td>${fmt(r.a)}</td><td class="${cls(dA)} d${dA>=0?'pos':'neg'}">${dA>=0?'+':''}${fmt(dA)}</td>` +
      `<td>${fmt(r.b)}</td><td class="${cls(dB)} d${dB>=0?'pos':'neg'}">${dB>=0?'+':''}${fmt(dB)}</td>` +
      `<td>${r.j == null ? '–' : (100*r.j).toFixed(0) + '%%'}</td>` +
      `<td>${r.rel === false ? '不可靠' : ''}</td></tr>`);
  }
  tbody.innerHTML = frag.join('');
  document.getElementById('count').textContent = frag.length + ' 行';
}
function scatter(id, key) {
  const W = 460, H = 400, M = 42, MAX = 19;
  const X = v => M + v / MAX * (W - M), Y = v => H - M - v / MAX * (H - M - 10);
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for (let t = 0; t <= MAX; t += 3) {
    s += `<line x1="${X(t)}" y1="${Y(0)}" x2="${X(t)}" y2="${Y(MAX)}" stroke="#eee"/>`;
    s += `<line x1="${X(0)}" y1="${Y(t)}" x2="${X(MAX)}" y2="${Y(t)}" stroke="#eee"/>`;
    s += `<text x="${X(t)}" y="${H - M + 16}" font-size="10" text-anchor="middle" fill="#666">${t}</text>`;
    if (t > 0) s += `<text x="${M - 6}" y="${Y(t) + 3}" font-size="10" text-anchor="end" fill="#666">${t}</text>`;
  }
  s += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(MAX)}" y2="${Y(MAX)}" stroke="#999" stroke-dasharray="4 3"/>`;
  for (const r of ROWS) {
    const v = r[key];
    if (v == null) continue;
    const c = r.rel === false ? '#e0a030' : '#2a7de1';
    s += `<circle cx="${X(r.e + (Math.random()-0.5)*0.05)}" cy="${Y(v)}" r="2.4" fill="${c}" fill-opacity="0.55"/>`;
  }
  s += `<text x="${W/2}" y="${H-6}" font-size="11" text-anchor="middle" fill="#444">expected</text>`;
  s += `<text x="12" y="${H/2}" font-size="11" transform="rotate(-90 12 ${H/2})" text-anchor="middle" fill="#444">got</text>`;
  s += `</svg><div class="small" style="text-align:center">${id}</div>`;
  document.getElementById('scatters').insertAdjacentHTML('beforeend', `<div>${s}</div>`);
}
function jackChart() {
  const W = 940, H = 400, M = 52, XM = 30, YMAX = 120;
  const X = v => XM + v * (W - XM - M), Y = v => H - M - Math.max(Math.min(v, YMAX), -YMAX) / YMAX * (H - M - 12);
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for (let t = -100; t <= YMAX; t += 25) {
    s += `<line x1="${X(0)}" y1="${Y(t)}" x2="${X(1)}" y2="${Y(t)}" stroke="${t===0?'#bbb':'#eee'}"/>`;
    s += `<text x="${XM - 6}" y="${Y(t) + 3}" font-size="10" text-anchor="end" fill="#666">${t}%%</text>`;
  }
  for (let t = 0; t <= 1.001; t += 0.1) {
    s += `<line x1="${X(t)}" y1="${Y(-YMAX)}" x2="${X(t)}" y2="${Y(YMAX)}" stroke="#eee"/>`;
    s += `<text x="${X(t)}" y="${H - M + 16}" font-size="10" text-anchor="middle" fill="#666">${t.toFixed(1)}</text>`;
  }
  s += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(0)}" stroke="#999" stroke-dasharray="4 3"/>`;
  for (const r of ROWS) {
    if (r.j == null || r.ln == null || r.ln >= 0.3) continue;
    const v = (r.e - r.a) / r.e * 100;
    s += `<circle cx="${X(r.j)}" cy="${Y(v)}" r="2.2" fill="#2a7de1" fill-opacity="0.4"/>`;
  }
  const line = (key, color) => {
    let p = '';
    for (const b of JACKCURVE) p += (p ? ' ' : '') + `${X(b.c).toFixed(1)},${Y(b[key]).toFixed(1)}`;
    return `<polyline points="${p}" fill="none" stroke="${color}" stroke-width="2.5"/>`;
  };
  s += line('pre', '#e0a030') + line('post', '#1a8a3c');
  s += `<text x="${W/2}" y="${H-6}" font-size="11" text-anchor="middle" fill="#444">jackShare（同列间隔&lt;180ms 占比）</text>`;
  s += `</svg>`;
  document.getElementById('jackchart').innerHTML = s;
}
renderTable();
scatter('Sunny', 's'); scatter('Azusa', 'z'); scatter('sky/P1H', 'a'); scatter('sky/P1H-jackBuffed', 'b');
jackChart();
document.getElementById('q').oninput = renderTable;
document.getElementById('pat').onchange = renderTable;
"""

overall_rows = []
for a in ALGOS:
    ds = [e - g for _, _, e, g in data[a]]
    deb = stats([d - overall[a]['bias'] for d in ds])
    overall_rows.append(f'<tr class="{"ours" if a in DISPLAY else ""}"><td>{esc(DISPLAY.get(a, a))}</td><td>{overall[a]["n"]}</td>'
                        f'<td>{overall[a]["mae"]:.3f}</td><td>{overall[a]["rmse"]:.3f}</td><td>{overall[a]["bias"]:+.3f}</td><td>{deb["mae"]:.3f}</td></tr>')

pat_rows = []
for a in ALGOS:
    pat_rows.append(f'<tr class="{"ours" if a in DISPLAY else ""}"><td>{esc(DISPLAY.get(a, a))}</td>'
                    + ''.join(f'<td>{stat_cell(by_pat[a][p], "mae")}</td>' for p in PATS) + '</tr>')

bin_rows = []
for a in ALGOS:
    bin_rows.append(f'<tr class="{"ours" if a in DISPLAY else ""}"><td>{esc(DISPLAY.get(a, a))}</td>'
                    + ''.join(f'<td>{stat_cell(s, "mae")} <span class="small">/ {s["n"] if s else 0}</span></td>' for s in by_bin[a]) + '</tr>')

tier_rows = ''.join(f'<tr><td>{esc(t["label"])}</td><td>{t["pos"]:.2f}</td><td>{t["star"]:.3f}</td>'
                    f'<td class="l">{esc(",".join(t["members"]) if t["merged"] else "")}</td></tr>' for t in tiers)

jack_bin_rows = ''.join(f'<tr><td class="l">j∈[{b["lo"]:.2f},{b["hi"]:.2f})</td><td>{b["n"]}</td>'
                        f'<td>{b["pre"]:+.1f}%</td><td>{b["post"]:+.1f}%</td></tr>' for b in bin_curves)

body = f"""
<main>
<h1>sky/P1H（osu-star-web）× VSRG-DanEstimation-Benchmark 对比报告</h1>
<div class="meta">生成于 {now} · 引擎 树星数 v1 (P1h, 2026-10-14) · 映射 = REFORM 段位锚点 + 线性插值（dan-estimate.js locateDan）· 倍速 1.0 · unreliable 行照写数字参与统计</div>

<div class="note"><b>读法</b>：delta = expected − got，正值 = 算法低估。<b>sky/P1H</b> 使用的映射：rf3 锚点用 REFORM 1st Pack v2 (DDMythical) 3rd 的读数 {debug['anchors'][0]['star']:.3f}★ 替代（Thaumiel 2nd/3rd 差 0.017★ 无法插值）；Reform Eta 之后的四叶草段（theta/iota/kappa）仅作映射锚点，不进 benchmark。<b>sky/P1H-jackBuffed</b> = sky/P1H + 两条经验分箱补正：米图（ln_frac&lt;0.3）以 jackShare 为自变量；LN（ln_frac≥0.3 且 expected≥5）以整谱 97% ScoreV2 读数的 LN 段位位置为自变量（expected&lt;5 的行标注本身有误，保持原样）。补正均在 benchmark 上拟合、留出一半交叉验证。原 rf3 对照版不再注册，文件保留在 <code>results/TreeStar-rf3.csv</code>。</div>

<h2>总体精度（全部 pattern）</h2>
<table>
<tr><th>algorithm</th><th>n</th><th>MAE</th><th>RMSE</th><th>bias</th><th>去偏 MAE</th></tr>
{''.join(overall_rows)}
</table>
<div class="small">n 差异：Daniel/Azusa/Roxy/DanOverlay 只支持 4K RC（ln 行标 Invalid）；Sunny/Mixed/Companella/sky 系列为 776 行减 4 行 Missing（data.csv 名称与文件括号备注不匹配且候选不唯一：Vertex Beta / Deadly force - Put an end / STRONG 280 / angel dust），按 runner 规范不参与统计。</div>

<h2>分 pattern MAE</h2>
<table>
<tr><th>algorithm</th>{''.join(f'<th>{p}</th>' for p in PATS)}</tr>
{''.join(pat_rows)}
</table>

<h2>分 expected 区间 MAE（n）</h2>
<table>
<tr><th>algorithm</th>{''.join(f'<th>{b1}–{b2}</th>' for b1, b2 in BINS)}</tr>
{''.join(bin_rows)}
</table>
<div class="small">模型支持范围（20834 张排名谱）为 ≤8.94★ ≈ 数值 15.3–15.7：15–17 桶一半以上、17–18.5 桶全部在外推区。模型可辨区间到 Zeta 为止，Eta–Kappa 因树模型封顶合并为一档（theta 与 iota 读数完全相同 9.747★，kappa 9.679★ 反而更低）。</div>

<h2>expected vs got 散点</h2>
<div class="scatterwrap" id="scatters"></div>
<div class="legend"><i style="background:#2a7de1"></i>在支持范围内（可靠）<i style="background:#e0a030"></i>超出支持范围（不可靠）<i style="background:#999"></i>虚线 = y=x</div>

<h2>误差% × jackShare（米图）</h2>
<div id="jackchart"></div>
<div class="legend"><i style="background:#2a7de1"></i>每行 = 一张米图（sky/P1H 的相对误差，纵轴截断 ±120%）<i style="background:#e0a030"></i>补正前分箱均值<i style="background:#1a8a3c"></i>补正后分箱均值</div>
<table>
<tr><th>jackShare 分箱</th><th>n</th><th>补正前误差%</th><th>补正后误差%</th></tr>
{jack_bin_rows}
</table>
<div class="small">误差% = (expected−got)/expected，带符号：正值 = 低估。曲线即补正曲线本身——补正量（段位）= 各箱 bias 的经验均值，分箱线性插值；也解释了为什么"全局偏移"在米侧本质是 jack 梯度（j&lt;0.2 的米图 bias 仅 ~0.35 段）。留出验证：A 半拟合→B 半 bias {fit['holdout']['fitA_apply_B']['pre']:+.3f}→{fit['holdout']['fitA_apply_B']['post']:+.3f}；B 半拟合→A 半 {fit['holdout']['fitB_apply_A']['pre']:+.3f}→{fit['holdout']['fitB_apply_A']['post']:+.3f}（单位：段）。线性形式（k={fit['linearRef']['k']:.3f}，封顶最大 +{fit['linearRef']['k']*0.5:.2f} 段）因曲线驼峰形而欠拟合，已弃用。注意：补正参数在 benchmark 上拟合，跨数据集泛化未验证；jackShare 与难度水平相关，补正可能吸收了部分难度相关的标定误差。</div>

<h2>LN 侧补正（面口径 97% ScoreV2）</h2>
<div class="small">方法：整谱 97% ScoreV2 读数（result.v2.star，与 LN Dan Courses v2 段位谱同标准）在 LN 锚点上定位为小数段位 lnPos（15 档锚点，PAV 合并后 {len(lnTiers)} 档），对 ln_frac≥0.3 且 expected≥5 的行（n={len(ln_scope)}）以 lnPos 为自变量拟合经验分箱补正（补正量加在米口径读数上）。动机：米口径（ScoreV1）对 LN 保持难度的低估随难度增长——e≥15 段 bias +1.60。expected&lt;5 的 15 行（bias −2.63）按所有者裁决视为标注错误，保持原样任其进 MAE。</div>
<table>
<tr><th>expected 分箱</th><th>n</th><th>bias 前</th><th>MAE 前</th><th>bias 后</th><th>MAE 后</th></tr>
{ln_bin_rows}
</table>
<table>
<tr><th>lnPos 补正分箱</th><th>n</th><th>bias（段）</th></tr>
{lnfit_rows}
</table>
<div class="small">留出验证：A 半拟合→B 半 MAE {lho['fitA_apply_B']['maePre']:.3f}→{lho['fitA_apply_B']['maePost']:.3f}、bias {lho['fitA_apply_B']['pre']:+.3f}→{lho['fitA_apply_B']['post']:+.3f}；B 半拟合→A 半 MAE {lho['fitB_apply_A']['maePre']:.3f}→{lho['fitB_apply_A']['maePost']:.3f}、bias {lho['fitB_apply_A']['pre']:+.3f}→{lho['fitB_apply_A']['post']:+.3f}。线性形式 e=1.672+0.905·lnPos（R²=0.946）因顶端欠拟合（e≥15 残余 +0.70）改用分箱。注意：顶端 [16,30) 箱仅 1 行（Reform eta 本体，lnPos 16.07），顶端外推依赖它；补正在 benchmark 上拟合，跨数据集泛化未验证。</div>

<h2>锚点与档位结构（sky/P1H）</h2>
<table>
<tr><th>档</th><th>pos</th><th>★</th><th>合并</th></tr>
{tier_rows}
</table>
<div class="small">3dan 锚点（v2 3rd）：{debug['anchors'][0]['star']:.3f}★ reliable；CloverWisp theta {debug['anchors'][1]['star']:.3f}★ / iota {debug['anchors'][2]['star']:.3f}★ / kappa {debug['anchors'][3]['star']:.3f}★ 全部 unreliable（超出排名谱支持范围）。Reform eta 本体读 9.786★，高于合并后的顶端档 → 外推 18.69。</div>
<table>
<tr><th>LN 锚点（lnPos 定位用，starV2）</th><th>pos</th><th>★</th><th>合并</th></tr>
{lntier_rows}
</table>

<h2>发现</h2>
<div class="finding"><b>映射自洽性成立</b>：16 条 REFORM 段位谱本体 MAE 0.174（1st→1.00、4th–15th 精确命中）——锚点+线性插值这把尺子内部一致。</div>
<div class="finding"><b>米侧偏移本质是 jack 梯度，LN 高难端低估由面口径收敛</b>：sky/P1H bias +0.680 → jackBuffed −0.054，总体 MAE 0.871 → 0.546（超过 Sunny 0.617 / Companella 0.625，逼近 Mixed 0.415）。米侧：jack 曲线把 jack MAE 1.335 → 0.609（低 jack 米图 j&lt;0.2 原本 bias 仅 +0.35 段——"整体低估 0.68"主要是 jack 密度越高读得越低）。LN 侧：面口径曲线把 ln≥15 MAE 1.600 → 0.362、ln≥5 MAE 0.780 → 0.454；expected&lt;5 的 15 行（bias −2.63，标注本身有误）按所有者裁决保持原样。剩余短板：jack 箱内 +0.5 段残差（jack180 一个变量解释不完 chordjack 的 pattern 性）。</div>
<div class="finding"><b>诚实性边界</b>：两条补正曲线（jack 与 LN）均在本 benchmark 上拟合；留出一半交叉验证显示组内泛化成立（jack holdout bias 收敛到 ±0.05 段内；LN holdout MAE 0.79→0.56 / 0.77→0.46，bias +0.20/−0.26），但跨数据集泛化未验证。jackShare 与 LN 段位读数都与难度相关，曲线可能吸收了部分难度相关的标定误差。Azusa/Roxy/DanOverlay 同样按本 benchmark 调参，此口径一致。</div>
<div class="finding"><b>四叶草段只能图一乐（实测确认）</b>：theta/iota/kappa 读数 9.75/9.75/9.68★，不仅全部 unreliable，且不高于 Reform eta（9.786★）——树模型在顶端封顶后，17 段以上完全没有分辨力，PAV 只能合并成一档 pos 18.5。</div>

<h2>逐行结果</h2>
<div class="filters">
<input id="q" type="text" placeholder="搜索谱名 / 子类…" style="flex:1;min-width:240px">
<select id="pat"><option value="all">全部 pattern</option>{''.join(f'<option value="{p}">{p}</option>' for p in PATS)}</select>
<span id="count" class="small"></span>
</div>
<table id="rowtable">
<tr><th>name</th><th>pattern</th><th>subPattern</th><th>expected</th><th>got(P1H)</th><th>Δ</th><th>got(Buffed)</th><th>Δ</th><th>jackShare</th><th>标记</th></tr>
<tbody id="rows"></tbody>
</table>
<div class="small">完整 CSV 随本仓库提供：<code>tools/benchmark/results/</code>（SkyP1H.csv / SkyP1H-jackBuffed.csv / TreeStar-rf3.csv）；同一套文件已注册进 <code>VSRG-DanEstimation-Benchmark-main/results/</code>（+ index.json），本地起 HTTP 服务打开该仓库 index.html 可与既有算法并排对比。</div>
</main>
"""

page = f"<!DOCTYPE html>\n<html lang=\"zh-cn\">\n<head><meta charset=\"utf-8\"><title>sky/P1H × DanEstimation Benchmark</title><style>{css}</style></head>\n<body>{body}<script>{js % (json.dumps(per_row, ensure_ascii=False), json.dumps(bin_curves))}</script></body>\n</html>"
open(OUT, 'w', encoding='utf-8').write(page)
print('written', OUT, os.path.getsize(OUT), 'bytes')
