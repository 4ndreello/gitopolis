# Debug HUD (F3)

## Objetivo

Ver, sem abrir o devtools, duas coisas que hoje só existem em `window.__city()` e no
console: **como o renderer está indo** (fps, memória, draw calls) e **o que o servidor
acabou de analisar** (quais arquivos mudaram, quanto o `git` demorou, o que disparou o
scan).

Duas superfícies:

- **linha compacta, sempre visível** — encostada no `#hud` que já existe.
- **painel F3** — tudo o resto, escondido por padrão.

Nada é desenhado na cena. Zero linha nova de three.js.

## A. Linha compacta

`index.html` ganha dois spans no `#hud`:

```html
<span class="sep">·</span>
<span id="r-fps">--</span>
<span id="r-mem"></span>
```

Preenchidos no bloco de 0,5 s que já atualiza o relógio (`main.js`, dentro de `tick`,
onde hoje só roda `el.clock.textContent = clockLabel(t)`). Nenhum timer novo.

- fps: a variável `fps` que já existe.
- memória: `performance.memory.usedJSHeapSize`. É **não-padrão e só Chromium**. Se
  `performance.memory` não existir, `#r-mem` fica com `textContent = ""` e some. Não se
  inventa número e não se estima.

## B. Painel F3

`index.html` ganha `<pre id="dbg" hidden>` posicionado `top:8px; right:10px`,
`pointer-events:none`, mesma fonte mono do HUD.

Toggle: `window.addEventListener("keydown", e => { if (e.key === "F3") { e.preventDefault(); ... } })`.
O `preventDefault` é obrigatório: F3 é "find again" no Firefox.

O painel só é preenchido quando visível (`if (el.dbg.hidden) return;` antes de montar a
string), no mesmo bloco de 0,5 s. Fechado custa zero.

### Conteúdo

```
render  58fps   31 dc   812k tris   9 progs
heap    142 / 2048 MB
city    51 files  3 dirty  1 crane  0 rising
fx      204 dust  12 smoke  4 flash
world   06:12  ·  overcast .81  ·  night .00
rain    YES  .34  ·  412 drops
cam     d 34.2 -> home 41.0  ·  attn 3
──── ingest ────────────────────────────────
18:40:02  watch  38ms   +2 ~1 -0
  ~ src/main.js      4.1k -> 4.3k
  + src/hud.js       -> 1.2k
18:39:44  poll   41ms   commit: 3 cranes down
18:39:12  watch  12ms   ~1
  ~ README.md        2.0k -> 2.1k
```

Fontes, todas já existentes:

| campo | fonte |
|---|---|
| fps | `fps` (já calculado em `tick`) |
| dc / tris / progs | `renderer.info.render.calls`, `.triangles`, `renderer.info.programs.length` |
| heap | `performance.memory.usedJSHeapSize` / `.jsHeapSizeLimit` |
| files / dirty / rising / cranes | `files` Map + `buildings` Map (já em `__city()`) |
| dust / smoke / flash | `dust.length`, `dust.filter(p => p.k).length`, `flashPool.filter(s => s.life > 0).length` |
| world / overcast / night | `clockLabel(t)`, `weatherAt(dayIndex(Date.now()))`, `nightK(t)` |
| rain | ver abaixo |
| cam | `camera.position.distanceTo(controls.target)`, `homeDist`, `attn` |

### Rain

`weatherAt` (`city.js:232`) devolve `rain: overcast > 0.72 ? (overcast-0.72)/0.28 : 0`,
ou seja **exatamente zero** quando não chove — o booleano não precisa de threshold
inventado.

A linha mostra três fatos de fontes diferentes de propósito:

- `YES`/`no` — `rainPoints.visible`, a verdade do que está na tela.
- `.34` — `weatherAt(...).rain`, a derivação.
- `412 drops` — `rainGeo.drawRange.count`.

Se `YES` aparecer com `0 drops`, derivação e render discordaram. É esse tipo de
divergência que o painel existe pra pegar.

### Não duplicar `__city()`

`window.__city()` e o painel leem os mesmos campos. O corpo de `__city()` vira uma
função `stats()` em `main.js`; o hook passa a ser `window.__city = stats`. Uma fonte só,
senão os dois divergem na primeira mudança.

`stats()` ganha os campos que hoje não tem: `dc`, `tris`, `progs`, `heap`, `heapMax`,
`raining`, `drops`, `overcast`, `flash`.

## C. Feed de ingest

Ring buffer de 8 entradas, alimentado dentro de `ingest()` — que já percorre o snapshot
inteiro pra decidir quem nasce, muda, morre e larga o andaime.

`ingest()` passa a coletar, além dos `done`/`gone` que já monta:

- `born` — `inc.path` quando `!cur`
- `changed` — `{ path, from: cur.target, to: inc.bytes }` quando os bytes mexem
- `gone` ganha o `path` junto das coordenadas (hoje só guarda `w`)
- `undirty` — `done.length`; `dirtied` — os que ficaram sujos

Uma entrada por snapshot, empurrada só se algo mudou (um snapshot idêntico já é
descartado no servidor, mas o cliente também não registra ruído).

Formato da entrada:

```
{ at: "18:40:02", why: "watch", ms: 38, add: 2, mod: 1, del: 0,
  cranes: 3, lines: ["~ src/main.js  4.1k -> 4.3k", "+ src/hud.js  -> 1.2k"] }
```

Até 3 `lines` por entrada; o excedente vira `... +12 more`. Sem isso um `git checkout`
de outra branch enche o painel inteiro com uma entrada só.

O cold open (primeiro snapshot: 51 arquivos novos) produz `+51` e é correto — é
literalmente o que foi analisado.

## D. `server.mjs`: `ms` e `why`

Snapshot ganha dois campos: `ms` (duração do `scan()`) e `why` ∈
`watch | poll | switch | open`.

### A armadilha

`broadcast()` deduplica com `body === lastPayload`. Se `ms` entrar nessa string, cada
poll de 700 ms gera bytes diferentes, o dedup nunca acerta, e o servidor passa a
transmitir 24 kB por segundo pra sempre — com o feed do painel virando lixo junto.

Correção: **deduplicar sobre os dados, anexar a meta depois**.

```js
function broadcast(snapshot, meta) {
  const body = JSON.stringify(snapshot);
  if (body === lastPayload) return;   // dedup ignora ms/why de propósito
  lastPayload = body;
  const frame = `data: ${JSON.stringify({ ...snapshot, ...meta })}\n\n`;
  for (const res of clients) res.write(frame);
}
```

### Quem disparou

`schedule(delay, why)` guarda o motivo do disparo pendente:

```js
let pending = null, pendingWhy = "poll";
function schedule(delay, why) {
  // um poll não rouba o crédito de um watch já agendado: o watch é a causa real
  if (why !== "poll" || !pending) pendingWhy = why;
  if (pending) clearTimeout(pending);
  pending = setTimeout(async () => {
    pending = null;
    const why = pendingWhy;
    pendingWhy = "poll";
    const t0 = performance.now();
    try {
      broadcast(await scan(), { ms: Math.round(performance.now() - t0), why });
    } catch (err) {
      console.error("scan failed:", err.message);
    }
  }, delay);
}
```

Chamadores: `watch` no `startWatch`, `poll` no `setInterval`, `switch` no `setActive`.
O snapshot inicial do `/events` sai com `{ ms, why: "open" }`.

`performance.now()` é global no Node desde a v16.

## E. `src/dbg.js`, puro

Arquivo novo, sem three.js e sem DOM — igual `city.js`, e pelo mesmo motivo:
`test.mjs` roda em node puro.

```js
export const LOG_MAX = 8;
export const LINES_MAX = 3;
export function fmtBytes(n)                      // 812, 4.1k, 1.2M
export function fmtDelta(kind, path, from, to)   // "~ src/main.js  4.1k -> 4.3k"
export function entryLines(diff)                 // corta em LINES_MAX, sufixa "... +N more"
export function pushLog(log, entry)              // unshift + corta em LOG_MAX
export function renderLog(log)                   // -> string do bloco de ingest
```

Motivo do arquivo separado, não de main.js: `main.js` já tem 1505 linhas, e formatação
de delta é lógica não-trivial que precisa de assert.

## F. Teste

`test.mjs` ganha um bloco importando `src/dbg.js`:

- `fmtBytes` nas fronteiras (999 → `999`, 1024 → `1.0k`, 0 → `0`)
- `pushLog` nunca passa de `LOG_MAX` e mantém o mais novo em cima
- `entryLines` de 15 mudanças devolve 4 linhas, a última sendo `... +12 more`

Um bloco, no estilo flat de `assert` do arquivo. Sem framework.

## Fora de escopo

Grade de quarteirões, label flutuando no prédio, marcador do foco da câmera. Nada aqui
bloqueia: entram depois lendo `roadLines()` / `intersections()` / `focus()`, que já são
exportados.

## Multi-repo simultâneo (futuro, não implementado aqui)

Não precisa de banco de dados. `listRepos()` já descobre os repos, e a invariante do
projeto é que **a cidade é projeção pura do working tree e nunca é persistida** — um DB
reintroduz exatamente o problema de reconciliação que o design existe pra evitar.

O que falta é mecânico: `active` vira um `Set`, N watchers, N polls, e o snapshot ganha
`repo` por arquivo. A pergunta difícil é visual, não de storage: cidades lado a lado, ou
cada repo virando um super-distrito dentro de uma cidade só? Merece brainstorm próprio.
