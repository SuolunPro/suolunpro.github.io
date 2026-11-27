"use strict";

function oddsProbabilities(odds) {
  const raw = odds.map(value => 1 / value);
  const sum = raw.reduce((total, value) => total + value, 0);
  return {raw, fair: raw.map(value => value / sum), payout: 1 / sum};
}

function poissonMass(lambda) {
  const masses = [Math.exp(-lambda)];
  for (let goals = 1; goals <= 72; goals++) {
    masses.push(masses[goals - 1] * lambda / goals);
    if (goals > lambda && masses[goals] < 1e-17) break;
  }
  return masses;
}

function independentPoisson(home, away) {
  const rows = poissonMass(home);
  const cols = poissonMass(away);
  const outcomes = [0, 0, 0];
  const totals = Array(rows.length + cols.length - 1).fill(0);
  const scores = [];
  rows.forEach((homeMass, h) => {
    cols.forEach((awayMass, a) => {
      const mass = homeMass * awayMass;
      outcomes[h > a ? 0 : h === a ? 1 : 2] += mass;
      totals[h + a] += mass;
      if (mass > 0) scores.push({h, a, mass});
    });
  });
  scores.sort((first, second) => second.mass - first.mass || first.h - second.h || first.a - second.a);
  return {rows, cols, outcomes, totals, top: scores.slice(0, 4),
    both: -Math.expm1(-home) * -Math.expm1(-away)};
}

if (typeof module !== "undefined") module.exports = {oddsProbabilities, independentPoisson};

if (typeof document !== "undefined") {
  const form = document.getElementById("traffic-calculator");
  const output = document.getElementById("traffic-output");
  const status = document.getElementById("traffic-status");
  const names = ["主胜", "平局", "客胜"];
  const percent = value => {
    if (value > 0 && value < 0.00005) return "<0.01%";
    return (value * 100).toFixed(2) + "%";
  };

  function makeTable(headers, rows) {
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    for (const header of headers) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = header;
      head.append(th);
    }
    const tbody = table.createTBody();
    for (const values of rows) {
      const row = tbody.insertRow();
      for (const value of values) {
        const cell = row.insertCell();
        if (value instanceof Node) cell.append(value);
        else cell.textContent = value;
      }
    }
    return table;
  }

  function addHeading(label) {
    const heading = document.createElement("h2");
    heading.textContent = label;
    output.append(heading);
  }

  function probabilityChart(values) {
    const bars = values.map((value, index) => {
      const bar = document.createElement("meter");
      bar.min = 0;
      bar.max = 1;
      bar.value = value;
      bar.setAttribute("aria-label", names[index] + "概率");
      return bar;
    });
    output.append(makeTable(["赛果", "理论概率", "概率图"],
      names.map((name, index) => [name, percent(values[index]), bars[index]])));
  }

  function showOdds(values) {
    const {raw, fair, payout} = oddsProbabilities(values);
    addHeading("理论返还率 " + percent(payout));
    output.append(makeTable(["赛果", "原始隐含概率", "去水概率", "理论公平赔率"],
      names.map((name, index) => [name, percent(raw[index]), percent(fair[index]),
        (1 / fair[index]).toPrecision(6)])));
    addHeading("去水概率图");
    probabilityChart(fair);
  }

  function showPoisson(values) {
    const {rows, cols, outcomes, totals, top, both} = independentPoisson(...values);
    addHeading("胜平负理论概率");
    probabilityChart(outcomes);
    addHeading("比分概率 Top4");
    output.append(makeTable(["主队:客队", "理论概率"], top.map(({h, a, mass}) => [h + ":" + a, percent(mass)])));
    addHeading("双方均进球 " + percent(both));
    addHeading("总进球概率分布");
    const cutoff = totals.reduce((last, value, index) => value >= 0.00005 ? Math.max(last, index) : last, 10);
    const shown = totals.slice(0, cutoff + 1).map((value, goals) => [goals, percent(value)]);
    const tail = totals.slice(cutoff + 1).reduce((sum, value) => sum + value, 0);
    if (tail > 0) shown.push([(cutoff + 1) + "+", percent(tail)]);
    output.append(makeTable(["进球数", "理论概率"], shown));
    addHeading("比分概率矩阵");
    const groups = masses => {
      const visible = Array.from({length: 9}, (_, index) => masses[index] ?? 0);
      visible.push(masses.slice(9).reduce((sum, mass) => sum + mass, 0));
      return visible;
    };
    const labels = [...Array.from({length: 9}, (_, index) => index), "9+"];
    const matrix = makeTable(["主队 ↓ 客队 →", ...labels], groups(rows).map((home, h) =>
      [labels[h], ...groups(cols).map(away => percent(home * away))]));
    const scroll = document.createElement("div");
    scroll.className = "traffic-matrix";
    scroll.tabIndex = 0;
    scroll.setAttribute("aria-label", "比分概率矩阵，可横向滚动");
    scroll.append(matrix);
    output.append(scroll);
  }

  form.addEventListener("input", () => {
    output.replaceChildren();
    status.textContent = "";
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const values = [...form.querySelectorAll("input")].map(input => input.valueAsNumber);
    const kind = form.dataset.kind;
    if (values.some(value => !Number.isFinite(value)
      || (kind === "probability" ? value < 1 : value < 0 || value > 20))) return;
    output.replaceChildren();
    if (kind === "probability") showOdds(values);
    else showPoisson(values);
    status.textContent = "计算完成";
    document.dispatchEvent(new Event("portal-" + kind + "-calculated"));
  });
}
