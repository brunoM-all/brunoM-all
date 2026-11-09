#!/usr/bin/env node
/**
 * Gera os cards SVG do profile (dark + light) a partir da API GraphQL do GitHub.
 *
 *   GITHUB_TOKEN=xxx node scripts/generate.mjs
 *
 * Com um token pessoal (PAT, escopos `repo` + `read:user`) as linguagens
 * incluem os repositórios privados. Com o GITHUB_TOKEN padrão da Action,
 * só os públicos entram na conta.
 */
import { writeFile, mkdir } from "node:fs/promises";

const LOGIN = process.env.GH_LOGIN || "brunoM-all";
const TOKEN = process.env.METRICS_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const OUT = new URL("../assets/", import.meta.url);
const EXCLUDE_LANGS = (process.env.EXCLUDE_LANGS || "").split(",").map((s) => s.trim()).filter(Boolean);

if (!TOKEN) {
  console.error("Defina GITHUB_TOKEN (ou METRICS_TOKEN).");
  process.exit(1);
}

// ───────────────────────────── dados ─────────────────────────────
async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "profile-cards" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data;
}

const QUERY = `
query($login: String!, $after: String) {
  user(login: $login) {
    createdAt
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      restrictedContributionsCount
      totalRepositoriesWithContributedCommits
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount weekday } }
      }
    }
    repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

async function fetchAll() {
  let after = null;
  let user;
  const repos = [];
  do {
    const data = await gql(QUERY, { login: LOGIN, after });
    user ??= data.user;
    repos.push(...data.user.repositories.nodes);
    const p = data.user.repositories.pageInfo;
    after = p.hasNextPage ? p.endCursor : null;
  } while (after);
  return { user, repos };
}

function computeStats({ user, repos }) {
  const cc = user.contributionsCollection;
  const days = cc.contributionCalendar.weeks.flatMap((w) => w.contributionDays);

  // streaks
  let longest = 0, run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  let i = days.length - 1;
  if (days[i]?.contributionCount === 0) i--; // hoje ainda pode estar vazio
  for (; i >= 0 && days[i].contributionCount > 0; i--) current++;

  // por dia da semana
  const weekday = Array(7).fill(0);
  for (const d of days) weekday[d.weekday] += d.contributionCount;

  // por semana
  const weekly = cc.contributionCalendar.weeks.map((w) => ({
    date: w.contributionDays[0].date,
    count: w.contributionDays.reduce((s, d) => s + d.contributionCount, 0),
  }));

  // linguagens
  const langs = new Map();
  for (const r of repos)
    for (const e of r.languages.edges) {
      if (EXCLUDE_LANGS.includes(e.node.name)) continue;
      const cur = langs.get(e.node.name) || { name: e.node.name, color: e.node.color || "#8b949e", size: 0 };
      cur.size += e.size;
      langs.set(e.node.name, cur);
    }
  const total = [...langs.values()].reduce((s, l) => s + l.size, 0) || 1;
  let langList = [...langs.values()].sort((a, b) => b.size - a.size).map((l) => ({ ...l, pct: (l.size / total) * 100 }));
  if (langList.length > 6) {
    const rest = langList.slice(5);
    langList = [...langList.slice(0, 5), { name: "Outras", color: "#6e7681", pct: rest.reduce((s, l) => s + l.pct, 0) }];
  }

  return {
    total: cc.contributionCalendar.totalContributions,
    commits: cc.totalCommitContributions + cc.restrictedContributionsCount,
    prs: cc.totalPullRequestContributions,
    reviews: cc.totalPullRequestReviewContributions,
    repos: user.repositories.totalCount,
    contributedRepos: cc.totalRepositoriesWithContributedCommits,
    current, longest, weekday, weekly, days, langs: langList,
    activeDays: days.filter((d) => d.contributionCount > 0).length,
    sinceYear: new Date(user.createdAt).getFullYear(),
  };
}

// ───────────────────────────── tema ─────────────────────────────
const THEMES = {
  dark: {
    bg: "#0d1117", card: "#11161f", border: "#262c36", grid: "#21262d",
    text: "#e6edf3", muted: "#8b949e", faint: "#6e7681",
    a1: "#a78bfa", a2: "#22d3ee", bar: "#30363d",
  },
  light: {
    bg: "#ffffff", card: "#f8f9fb", border: "#d0d7de", grid: "#eaeef2",
    text: "#1f2328", muted: "#59636e", faint: "#818b98",
    a1: "#7c3aed", a2: "#0891b2", bar: "#d8dee4",
  },
};

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const WEEKDAYS_FULL = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const fmt = (n) => Math.round(n).toLocaleString("pt-BR");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function frame(t, w, h, title, body, extraDefs = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<defs>
  <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${t.a1}"/><stop offset="1" stop-color="${t.a2}"/>
  </linearGradient>
  <linearGradient id="accentV" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${t.a1}"/><stop offset="1" stop-color="${t.a2}"/>
  </linearGradient>
  ${extraDefs}
</defs>
<style>
  text { font-family: ${FONT}; fill: ${t.text}; }
  .muted { fill: ${t.muted}; }
  .faint { fill: ${t.faint}; }
  .h { font-size: 13px; font-weight: 600; letter-spacing: .4px; text-transform: uppercase; fill: ${t.muted}; }
  .fade { opacity: 0; animation: fade .6s ease-out forwards; }
  .grow { transform-box: fill-box; transform-origin: bottom; transform: scaleY(0); animation: grow .7s cubic-bezier(.2,.8,.2,1) forwards; }
  .growx { transform-box: fill-box; transform-origin: left; transform: scaleX(0); animation: growx .8s cubic-bezier(.2,.8,.2,1) forwards; }
  .draw { stroke-dasharray: 3000; stroke-dashoffset: 3000; animation: draw 1.8s ease-out forwards; }
  @keyframes fade { to { opacity: 1; } }
  @keyframes grow { to { transform: scaleY(1); } }
  @keyframes growx { to { transform: scaleX(1); } }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) { .fade,.grow,.growx,.draw { animation: none; opacity: 1; transform: none; stroke-dashoffset: 0; } }
</style>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14" fill="${t.card}" stroke="${t.border}"/>
${body}
</svg>`;
}

// ─────────────── card 1: visão geral (hero + tiles + área semanal) ───────────────
function overviewCard(s, t) {
  const W = 840, H = 300;
  const tiles = [
    ["Commits", fmt(s.commits)],
    ["Pull requests", fmt(s.prs)],
    ["Dias ativos", fmt(s.activeDays)],
    ["Streak atual", `${s.current} d`],
    ["Maior streak", `${s.longest} d`],
    ["Repositórios", fmt(s.repos)],
  ];
  const tileW = 150, tileH = 54, gx = 12, gy = 12, tx0 = W - 24 - (tileW * 3 + gx * 2), ty0 = 28;
  const tilesSvg = tiles
    .map(([label, val], i) => {
      const x = tx0 + (i % 3) * (tileW + gx), y = ty0 + Math.floor(i / 3) * (tileH + gy);
      return `<g class="fade" style="animation-delay:${0.1 + i * 0.07}s">
  <rect x="${x}" y="${y}" width="${tileW}" height="${tileH}" rx="10" fill="${t.bg}" stroke="${t.border}"/>
  <text x="${x + 14}" y="${y + 21}" font-size="11.5" class="muted">${label}</text>
  <text x="${x + 14}" y="${y + 42}" font-size="18" font-weight="700">${val}</text>
</g>`;
    })
    .join("\n");

  // área semanal
  const cx = 24, cy = 168, cw = W - 48, ch = 96;
  const max = Math.max(...s.weekly.map((w) => w.count), 1);
  const n = s.weekly.length;
  const pts = s.weekly.map((w, i) => [cx + (i / (n - 1)) * cw, cy + ch - (w.count / max) * ch]);
  // curva suave (catmull-rom → bezier)
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, Math.min(cy + ch, p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, Math.min(cy + ch, p2[1] - (p3[1] - p1[1]) / 6)];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const area = `${d} L${cx + cw},${cy + ch} L${cx},${cy + ch} Z`;

  const grid = [0.5, 1]
    .map((f) => {
      const y = cy + ch - f * ch;
      return `<line x1="${cx}" x2="${cx + cw}" y1="${y}" y2="${y}" stroke="${t.grid}" stroke-dasharray="3 4"/>
<text x="${cx + cw}" y="${y - 5}" font-size="10" text-anchor="end" class="faint">${fmt(f * max)}</text>`;
    })
    .join("\n");

  let lastM = -1;
  const monthLabels = s.weekly
    .map((w, i) => {
      const m = new Date(w.date + "T12:00:00Z").getUTCMonth();
      if (m === lastM || i > n - 3) return "";
      const first = lastM === -1;
      lastM = m;
      if (first && new Date(w.date + "T12:00:00Z").getUTCDate() > 7) return "";
      return `<text x="${pts[i][0].toFixed(1)}" y="${cy + ch + 18}" font-size="10.5" class="faint">${MONTHS[m]}</text>`;
    })
    .join("");

  const peak = s.weekly.reduce((a, b) => (b.count > a.count ? b : a));
  const pi = s.weekly.indexOf(peak);
  const [px, py] = pts[pi];
  const peakLabelAnchor = px > W - 160 ? "end" : px < 160 ? "start" : "middle";

  const defs = `<linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${t.a1}" stop-opacity=".35"/><stop offset="1" stop-color="${t.a2}" stop-opacity="0"/>
  </linearGradient>`;

  const body = `
<text x="24" y="40" class="h">Atividade · últimos 12 meses</text>
<text x="22" y="98" font-size="52" font-weight="800" fill="url(#accent)" style="fill:url(#accent)" class="fade">${fmt(s.total)}</text>
<text x="24" y="124" font-size="14" class="muted">contribuições em ${fmt(s.contributedRepos)} repositórios</text>
${tilesSvg}
${grid}
<path d="${area}" fill="url(#areaFill)" class="fade" style="animation-delay:.5s"/>
<path d="${d}" fill="none" stroke="url(#accent)" stroke-width="2" stroke-linecap="round" class="draw"/>
<g class="fade" style="animation-delay:1.6s">
  <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5" fill="${t.a2}" stroke="${t.card}" stroke-width="2"/>
  <text x="${px.toFixed(1)}" y="${(py - 12).toFixed(1)}" font-size="11" font-weight="600" text-anchor="${peakLabelAnchor}">pico: ${fmt(peak.count)}/semana</text>
</g>
${monthLabels}`;
  return frame(t, W, H, `${fmt(s.total)} contribuições nos últimos 12 meses`, body, defs);
}

// ───────────────────────── card 2: linguagens ─────────────────────────
function languagesCard(s, t) {
  const W = 414, H = 250, x0 = 24, bw = W - 48, by = 64, bh = 12, gap = 2;
  const usable = bw - gap * (s.langs.length - 1);
  let x = x0;
  const segs = s.langs
    .map((l, i) => {
      const w = Math.max(2, (l.pct / 100) * usable);
      const r = `<rect x="${x.toFixed(1)}" y="${by}" width="${w.toFixed(1)}" height="${bh}" rx="3" fill="${l.color}"/>`;
      x += w + gap;
      return r;
    })
    .join("");
  const list = s.langs
    .map((l, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const lx = x0 + col * (bw / 2 + 6), ly = 116 + row * 40;
      return `<g class="fade" style="animation-delay:${0.4 + i * 0.08}s">
  <circle cx="${lx + 6}" cy="${ly - 4}" r="6" fill="${l.color}"/>
  <text x="${lx + 20}" y="${ly}" font-size="14" font-weight="600">${esc(l.name)}</text>
  <text x="${lx + 20}" y="${ly + 17}" font-size="12" class="muted">${l.pct.toFixed(1).replace(".", ",")}%</text>
</g>`;
    })
    .join("\n");
  const body = `
<text x="24" y="40" class="h">Linguagens mais usadas</text>
<g class="growx">${segs}</g>
${list}`;
  return frame(t, W, H, "Linguagens mais usadas: " + s.langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(", "), body);
}

// ───────────────────────── card 3: ritmo semanal ─────────────────────────
function rhythmCard(s, t) {
  const W = 414, H = 250, x0 = 24, cw = W - 48, cy = 96, ch = 104;
  const max = Math.max(...s.weekday, 1);
  const best = s.weekday.indexOf(max);
  const slot = cw / 7, bw = 30;
  const bars = s.weekday
    .map((v, i) => {
      const h = Math.max(4, (v / max) * ch);
      const bx = x0 + i * slot + (slot - bw) / 2, byy = cy + ch - h;
      const fill = i === best ? "url(#accentV)" : t.bar;
      // topo arredondado (4px), base reta no baseline
      const r = 4;
      const path = `M${bx},${cy + ch} V${byy + r} Q${bx},${byy} ${bx + r},${byy} H${bx + bw - r} Q${bx + bw},${byy} ${bx + bw},${byy + r} V${cy + ch} Z`;
      return `<path d="${path}" fill="${fill}" class="grow" style="animation-delay:${0.1 + i * 0.06}s"/>
<text x="${bx + bw / 2}" y="${byy - 7}" font-size="11" text-anchor="middle" class="${i === best ? "" : "muted"}" font-weight="${i === best ? 700 : 400}">${fmt(v)}</text>
<text x="${bx + bw / 2}" y="${cy + ch + 20}" font-size="11.5" text-anchor="middle" class="${i === best ? "" : "faint"}">${WEEKDAYS[i]}</text>`;
    })
    .join("\n");
  const body = `
<text x="24" y="40" class="h">Ritmo da semana</text>
<text x="24" y="60" font-size="12.5" class="muted">Dia mais produtivo: <tspan font-weight="700" style="fill:${t.text}">${WEEKDAYS_FULL[best]}</tspan></text>
<line x1="${x0}" x2="${x0 + cw}" y1="${cy + ch}" y2="${cy + ch}" stroke="${t.border}"/>
${bars}`;
  return frame(t, W, H, `Contribuições por dia da semana; mais produtivo: ${WEEKDAYS_FULL[best]}`, body);
}

// ───────────────────────────── main ─────────────────────────────
const stats = computeStats(await fetchAll());
await mkdir(OUT, { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
  await writeFile(new URL(`overview-${name}.svg`, OUT), overviewCard(stats, t));
  await writeFile(new URL(`languages-${name}.svg`, OUT), languagesCard(stats, t));
  await writeFile(new URL(`rhythm-${name}.svg`, OUT), rhythmCard(stats, t));
}
console.log(
  `ok: ${stats.total} contribuições · ${stats.commits} commits · streak ${stats.current}/${stats.longest} · ` +
    stats.langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(", ")
);
