// the F3 cheat panel: the clickable half of window.__time / window.__toggle.
//
// it lives in its own file for one reason — main.js is already the biggest
// thing here and three agents edit it at once. the coupling is deliberately
// one object: `cheat` holds a nullable override per knob, null meaning "follow
// the world". main.js reads it at the handful of points that sample the day,
// so nothing here needs three.js and the whole file loads in plain node.
//
// the invariant from CLAUDE.md survives: weatherAt/dayT stay pure functions of
// the clock. a cheat is an override read at the sampling site, never a value
// written back into the world — reload and the city is the same projection
// again, because nothing is persisted.

// every knob is null (auto) until the user drags it. clouds counts groups, the
// rest are 0..1 multipliers matching what weatherAt/trafficAt return.
export const cheat = { rain: null, overcast: null, clouds: null, traffic: null };

// the one bit of logic worth a test: an override of 0 has to win over the
// world, so this cannot be `||`. `?? ` on each field, not on the object, or
// forcing rain would also freeze overcast at whatever it was.
export function mergeWeather(auto, ov = cheat) {
  return {
    overcast: ov.overcast ?? auto.overcast,
    rain: ov.rain ?? auto.rain,
  };
}

// minutes -> "HH:MM", same shape as clockLabel but from a minute count. kept
// local so this file stays importable with no dependency at all.
function hhmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// slider spec. `set` is what a drag does, `fmt` is what the value column reads.
// time is not in `cheat`: main.js already has frozenT and window.__time for it,
// and reusing that is one less place for the hour to be sampled from.
const KNOBS = [
  { key: "time", label: "hora", max: 1439, step: 5, fmt: hhmm },
  { key: "rain", label: "chuva", max: 100, step: 1, fmt: v => `${v}%` },
  { key: "overcast", label: "nublado", max: 100, step: 1, fmt: v => `${v}%` },
  { key: "clouds", label: "nuvens", max: 8, step: 1, fmt: v => String(v) },
  { key: "traffic", label: "trânsito", max: 100, step: 1, fmt: v => `${v}%` },
];

const TOGGLES = ["dust", "cars", "clouds", "city", "ground", "flood"];

// hooks: { setTime(t|null), getTime() -> 0..1, toggle(name), cloudMax }
export function mountCheat(root, hooks) {
  root.innerHTML = "";
  const h = document.createElement("h4");
  h.textContent = "cheats";
  root.append(h);

  const rows = [];
  for (const k of KNOBS) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("b");
    name.textContent = k.label;
    const input = document.createElement("input");
    input.type = "range";
    input.min = 0; input.max = k.max; input.step = k.step;
    const val = document.createElement("i");
    val.className = "auto";
    val.title = "clique para voltar ao automático";
    row.append(name, input, val);
    root.append(row);

    const read = () => (k.key === "time"
      ? (hooks.getTime() === null ? null : Math.round(hooks.getTime() * 1440) % 1440)
      : cheat[k.key] === null ? null : Math.round(cheat[k.key] * (k.key === "clouds" ? 1 : 100)));

    const write = (raw) => {
      if (k.key === "time") hooks.setTime(raw === null ? null : raw / 1440);
      else cheat[k.key] = raw === null ? null : (k.key === "clouds" ? raw : raw / 100);
    };

    input.addEventListener("input", () => write(+input.value));
    // the value column is the reset: a knob is either following the world or
    // overriding it, so one click back to auto beats a second control per row
    val.addEventListener("click", () => { write(null); sync(); });
    rows.push({ k, input, val, read });
  }

  const togs = document.createElement("div");
  togs.className = "togs";
  const tbtns = [];
  for (const name of TOGGLES) {
    const b = document.createElement("button");
    b.textContent = name;
    b.addEventListener("click", () => {
      hooks.toggle(name);
      // no getter for the toggles in main.js, so the button owns its own state.
      // it can only drift if something else calls __toggle from the console.
      b.toggleAttribute("data-off", !b.hasAttribute("data-off"));
    });
    togs.append(b);
    tbtns.push(b);
  }
  root.append(togs);

  // the sliders are live readouts while on auto: the clock keeps moving, so a
  // panel that showed a stale hour would look broken before it looked automatic
  function sync(live) {
    for (const r of rows) {
      const v = r.read();
      const auto = v === null;
      r.val.classList.toggle("auto", auto);
      const shown = auto ? (live ? live[r.k.key] : null) : v;
      r.val.textContent = shown === null || shown === undefined ? "auto" : r.k.fmt(shown);
      // dragging must not fight the live value the same frame the user moves it
      if (document.activeElement !== r.input && shown !== null && shown !== undefined) {
        r.input.value = shown;
      }
    }
  }
  // the first live sync is up to half a second away, and a panel of blank value
  // columns in the meantime reads as broken rather than as automatic
  sync();
  return sync;
}
