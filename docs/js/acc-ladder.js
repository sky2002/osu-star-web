// 达成水平阶梯：打到 t% acc（ScoreV1）需要多强，用总星数同一刻度表示。不碰 DOM，Node 里也能 import 测试。
// 规则只依赖该倍速的总星数（96% 读数）：star_t = star_96 + B·(y96 − y_t) / ŝ(star_96)，y_t = log(1 − t/100 + 0.005)。
// ŝ 是人群尺子里"难谱上强弱玩家差距更大"的斜率按星数拟合的曲线；参数与观测/外推表见 model/acc-ladder.json。
// Python 参照实现：研究仓库 analysis/acc-ladder-r1/ladder_ref.py（tests/acc-ladder.mjs 逐位核对）。

export const LADDER_TITLE = '达成水平';
export const LADDER_CAPTION =
  '打到某个 acc（stable ScoreV1，OD 同总星数）平均需要多强，用总星数同一刻度表示；96% 一行就是总星数。'
  + '只按难度换算台阶，不看键型。';
export const LADDER_LABEL = {
  observed: { text: '观测', title: '打过这张谱的玩家里，有人的水平落在这条线附近，有成绩直接支撑' },
  extrap: { text: '外推', title: '这条线超出了打过同等难度谱的大部分玩家的水平范围，按直线外推，可信度较低' },
};
export const LADDER_LN_NOTE = '长条较多：这里按 ScoreV1 acc 计算，不是 LN / 混合段位常用的 97% ScoreV2 口径';
export const LADDER_UNRELIABLE_NOTE = '总星数被标为不可靠，这张表同样不可靠';
const LN_NOTE_MIN = 0.3;

export function validateLadder(P) {
  if (!P || !P.curves || !P.curves.nomod || !P.curves.dt || !P.coverage || !P.reverse) throw new Error('达成水平参数不完整');
  return P;
}

function curveKey(rate) { return rate === 1.5 ? 'dt' : 'nomod'; }   // HT 没有人群成绩：沿用 NoMod 曲线与表

export function yOf(P, t) { return Math.log(1 - t / 100 + P.eps); }

export function logSlope(P, star96, rate) {
  const c = P.curves[curveKey(rate)];
  const u = Math.min(Math.max(star96, c.u_lo), c.u_hi);
  if (c.form === 'quad') {
    const [c0, c1, c2] = c.coef;
    return c0 + c1 * u + c2 * u * u;
  }
  const xs = c.knots_x, ys = c.knots_y;   // 分箱中位数之间线性插值，两端持平
  if (u <= xs[0]) return ys[0];
  if (u >= xs[xs.length - 1]) return ys[ys.length - 1];
  let k = 1;
  while (xs[k] < u) k++;
  const f = (u - xs[k - 1]) / (xs[k] - xs[k - 1]);
  return ys[k - 1] + (ys[k] - ys[k - 1]) * f;
}

export function ladderStar(P, star96, t, rate = 1) {
  const s = Math.exp(logSlope(P, star96, rate));
  return star96 + P.star_b * (yOf(P, 96) - yOf(P, t)) / s;
}

function tIndex(P, t) {
  const g = P.coverage.t_grid;
  const tt = Math.floor(t * 2 + 0.5) / 2;
  let best = 0;
  for (let i = 0; i < g.length; i++) if (Math.abs(g[i] - tt) < Math.abs(g[best] - tt)) best = i;
  return best;
}

function starBin(P, star96) {
  const e = P.coverage.star_edges;
  let k = 0;
  while (k < e.length && e[k] <= star96) k++;
  return k;
}

export function ladderLabel(P, star96, t, rate = 1) {
  const tab = P.coverage.tables[curveKey(rate)];
  return tab.label[starBin(P, star96)][tIndex(P, t)] ? 'observed' : 'extrap';
}

export function ladder(P, star96, t, rate = 1) {
  const star = ladderStar(P, star96, t, rate);
  return { star, below: star < P.below, label: ladderLabel(P, star96, t, rate) };
}

/** 输入框的 acc：合法返回数字，否则 null。 */
export function parseAcc(P, text) {
  const v = Number(String(text).trim().replace('%', ''));
  const [lo, hi] = P.input_range;
  return Number.isFinite(v) && v >= lo && v <= hi ? v : null;
}

/** 反向读数（"这一局 ≈ X 星水平"）的提示：null 表示没有额外提示。 */
export function reverseNote(P, t) {
  const R = P.reverse;
  if (t >= R.unreliable_at_or_above || t < R.unreliable_below) return { level: 'bad', text: `反过来读：acc ≥${R.unreliable_at_or_above}% 或 <${R.unreliable_below}% 的单局，反推水平不可靠` };
  if (t < R.low_note_below) return { level: 'warn', text: `反过来读：低于 ${R.low_note_below}% 的单局多半有失误，反推的水平通常偏低` };
  return null;
}

export function reverseCaption(P) {
  const R = P.reverse;
  const sd = R.sd_single;
  return `反过来读：如果你在这张谱上打出 t%，大致相当于表中这个星数的水平。单局波动大（标准差约 ${Math.min(...sd).toFixed(1)}–${Math.max(...sd).toFixed(1)} 星），`
    + `只能作参考；acc ≥${R.unreliable_at_or_above}% 或 <${R.unreliable_below}% 时不可靠。`;
}

export function lnNote(result) {
  if (!result) return null;
  const v = Number.isFinite(result.lnFrac) ? result.lnFrac : result.features && result.features.ln_frac;   // worker 只回传 lnFrac
  return Number.isFinite(v) && v >= LN_NOTE_MIN ? LADDER_LN_NOTE : null;
}

export function fmtLadderStar(row) {
  return row.below ? '低于刻度' : '★ ' + row.star.toFixed(2);
}

/** 「复制读数信息」里的一行。 */
export function ladderCopyLine(P, result) {
  if (!P || !result || !result.ok) return null;
  const parts = P.presets.map((t) => {
    const r = ladder(P, result.star, t, result.rate || 1);
    return `${t}% ${r.below ? '<0.5' : r.star.toFixed(2)}${r.label === 'extrap' ? '（外推）' : ''}`;
  });
  return `达成水平（ScoreV1）：${parts.join(' / ')}`;
}
