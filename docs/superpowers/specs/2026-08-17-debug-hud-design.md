# Debug HUD (F3)

Revisado depois de dois passes de review. As decisões que mudaram estão marcadas
**[rev]** com o motivo — elas são o conteúdo mais útil deste documento.

## Objetivo

Ver, sem abrir o devtools, duas coisas que hoje só existem em `window.__city()`:
**como o renderer está indo** e **o que o servidor acabou de analisar**.

Duas superfícies:

- **linha compacta, sempre visível** — encostada no `#hud` que já existe.
- **painel F3** — todo o resto, escondido por padrão.

Nada é desenhado na cena. Zero linha nova de three.js.

## A. Linha compacta

Dois spans no `#hud` do `index.html`:

```html
<span class="sep">·</span>
<span id="r-fps">--</span>
<span id="r-mem"></span>
```

Preenchidos no bloco de 0,5 s que já existe dentro de `tick` (onde hoje só roda
`el.clock.textContent = clockLabel(t)`). Nenhum timer novo.

## B. Painel F3

```html
<pre id="dbg" hidden></pre>
```

```css
#dbg {
  position: fixed; top: 8px; right: 10px; z-index: 6;
  margin: 0; font: inherit; pointer-events: none;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
  text-align: right; font-variant-numeric: tabular-nums;
}
#dbg[hidden] { display: none; }
```

Três detalhes de CSS que **[rev]** são obrigatórios, não estilo:

- `z-index: 6` — `#boot` é `position:fixed; inset:0; z-index:5` e só sai de cena via
  `opacity`. Sem isso o painel fica atrás da cortina exatamente durante o cold open,
  que é o único momento em que a entrada `+51` do feed interessa.
- `margin: 0; font: inherit` — a UA stylesheet de `<pre>` reseta `font-family` para
  `monospace` e `font-size` para `medium`, e injeta `margin: 1em 0`. "Mesma fonte do
  HUD" não sai de graça.
- `#dbg[hidden] { display: none }` explícito — qualquer regra de autor com `display`
  vence o `[hidden]` da UA por origem, e o atributo vira no-op.

### Toggle

```js
addEventListener("keydown", (e) => {
  if (e.key !== "F3") return;
  e.preventDefault();            // F3 é "find again" no Firefox
  el.dbg.hidden = !el.dbg.hidden;
});
```

### Preenchimento

Dentro do bloco de 0,5 s que já existe:

```js
if (!el.dbg.hidden) el.dbg.textContent = dbgText();
```

**[rev] Nunca `if (el.dbg.hidden) return;`.** O `requestAnimationFrame(tick)` fica
*depois* desse bloco; um `return` ali sai de `tick` inteiro e congela a cidade no
primeiro fechamento do painel — além de pular o relógio e o reset de `fpsAcc/fpsN`.

Fechado, o painel custa uma comparação de booleano a cada meio segundo.

### Conteúdo

Uma chave por linha, geradas por `Object.entries(stats())`. **A ordem dos campos no
literal de `stats()` é o layout do painel** — não existe código de curadoria, e o
painel nunca diverge de `window.__city()`.

```
fps        58
dc         31
tris       812k
geo        412
tex        18
heap       142 MB
files      51
dirty      3
cranes     1
rising     0
parts      204
smoke      12
clock      06:12
overcast   .81
raining    YES
watch      on
scan       38ms
──── ingest ─────────────────────────
18:40:02   ~ src/main.js  4.1k → 4.3k
18:39:44   +2 ~1 -0 · 3 cranes down
18:39:12   ~ README.md    2.0k → 2.1k
```

### Campos que mudaram no review

**[rev] `geo` / `tex` (`renderer.info.memory`) entram, e são o campo mais importante
do painel.** `performance.memory.usedJSHeapSize` é bucketizado em 100 KB e **cacheado
por ~20 min** sem `--enable-precise-memory-info` — ou seja, um número parado, inútil
pro caso de uso que pediu ele ("ver a RAM subindo"). `heap` fica porque foi pedido e é
grátis, mas o detector de vazamento real neste app é a contagem de geometrias e
texturas: se `disposeBuilding` deixar de dispor, elas sobem monotonicamente e nunca
descem. Preciso, exato, e já contado pelo three.

`heap` some da tela quando `performance.memory` não existe (não-Chromium). Não se
inventa nem se estima número.

**[rev] `parts` / `smoke` deixam claro que são total e subconjunto.** `smoke` é
`dust.filter(p => p.k)` — mostrar `204 dust · 12 smoke` lado a lado como categorias
irmãs dava a entender 216 partículas.

**[rev] `drops` cortado.** Ia imprimir `Infinity` até a primeira chuva
(`drawRange = {start:0, count:Infinity}` é o default do three) e depois ficar preso no
último valor não-zero, porque `updateRain` faz `if (!n) return;` *antes* do
`setDrawRange`. Pior: o "detector de divergência" que justificava o campo é impossível
por construção — `rainPoints.visible = n > 0` deriva do mesmo `weather.rain`, no mesmo
frame. Detectava um bug que não pode acontecer, e reportava um que não existe.

**[rev] `night`, `progs`, `camDist`, `homeDist`, `attn` ficam fora do painel** —
redundantes com o relógio, constantes depois do warmup, ou só interessantes pra quem
está tunando `driveCamera`. Continuam em `window.__city()`, que os smoke tests usam.

### `stats()`

O corpo de `window.__city()` vira `const stats = () => ({...})`, e o hook vira
`window.__city = stats`. Duas linhas, não é refatoração: é o que faz o painel e o hook
não divergirem. `stats()` ganha `dc`, `tris`, `geo`, `tex`, `heap`, `raining`,
`overcast`, `clock`, `rising`, `watch`, `scan`.

## C. Feed de ingest

**[rev] Uma linha por snapshot**, não um bloco de até 3 paths com truncamento. O pedido
era "o que a gente analisou", não um `git log` na tela. Isso mata `entryLines`,
`LINES_MAX`, o sufixo `... +N more` e o problema do `git checkout` de outra branch
enchendo o painel com uma entrada só.

Quando exatamente um arquivo muda — o caso comum — a linha mostra o path e o delta:

```
18:40:02   ~ src/main.js  4.1k → 4.3k
```

Caso contrário, contadores:

```
18:39:44   +2 ~1 -0 · 3 cranes down
```

Ring buffer de 8: `log.unshift(s); if (log.length > 8) log.pop();`.

Alimentado por uma linha no fim de `ingest()`, que já percorre o snapshot inteiro pra
decidir quem nasce, muda, morre e larga o andaime. `ingest()` passa a contar `born` e
`changed` junto dos `done`/`gone` que já monta.

Empurra só se algo mudou. **[rev]** Isso deixa de ser higiene e vira necessário: num
switch de repo o cliente recebe dois frames pro mesmo evento (o `scan()` direto do
`/events` e o `broadcast` agendado por `setActive`), e o guard é o que impede a entrada
duplicada.

O cold open produz `+51 ~0 -0` e está correto — é literalmente o que foi analisado.

## D. `server.mjs`

Dois campos novos no snapshot: `ms` e `watching`.

### `ms` e a armadilha do dedup

`broadcast()` deduplica com `body === lastPayload`. Se `ms` entrar nessa string, cada
poll de 700 ms gera bytes diferentes, o dedup nunca acerta, e o servidor passa a
transmitir pra sempre — com o feed do painel virando lixo junto.

Deduplica sobre os dados, anexa a meta depois:

```js
function broadcast(snapshot, ms) {
  const body = JSON.stringify(snapshot);
  if (body === lastPayload) return;   // ms fica fora do dedup de propósito
  lastPayload = body;
  const frame = `data: ${JSON.stringify({ ...snapshot, ms })}\n\n`;
  for (const res of clients) res.write(frame);
}
```

`broadcast` tem um único chamador (dentro de `schedule`), então a assinatura nova não
quebra nada. `lastPayload = null` no `setActive` continua correto: o dedup segue sendo
sobre o snapshot puro.

O `/events` de cliente novo escreve `scan()` direto e **[rev] não pode virar
`broadcast()`** — o comentário no arquivo explica que setar `lastPayload` ali suprimia
o broadcast pós-switch pros outros clientes. Ele mede o próprio `ms` e anexa igual.

### `watching`, em vez de `why`

**[rev] O `why` (`watch|poll|switch|open`) foi cortado: ele mentiria no caso comum.**

- `setActive` agenda `schedule(0, "switch")` e logo em seguida `startWatch()` reabre o
  watcher no repo novo; qualquer evento de fs nos ms seguintes vira `schedule(140,
  "watch")`, que sobrescreve o motivo **e** empurra o disparo de 0 pra 140 ms.
- No sentido oposto, `schedule` faz `clearTimeout` incondicional: o poll de 700 ms mata
  o timer do watch e agenda o seu, mas uma guarda de prioridade preservaria o rótulo
  `watch`. Como `.git/` é filtrado do watcher, **só o poll pega commits** — então o
  frame "3 cranes down" sairia rotulado `watch`. O poll rouba o timer e doa o crédito.

Qualquer versão disso precisa de lógica de prioridade que ainda erra. O sinal que valia
a pena é outro e é estático: `startWatch()` tem um `catch` que cai pra poll-only com um
`console.warn` que ninguém lê, e aí a latência ganha um piso de 700 ms sem explicação.
Então o snapshot carrega `watching: watcher !== null`. Mesmo diagnóstico, zero timing,
e não fura o dedup porque só muda quando o estado muda de verdade.

`performance.now()` é global no Node desde a v16.

## E. `fmtBytes` em `src/city.js`

**[rev] Sem `src/dbg.js`.** Com o feed em uma linha por snapshot sobra uma função de
formatação, e `city.js` já hospeda `clockLabel` — precedente exato de formatador puro,
já importado por `test.mjs`. Um arquivo novo com cinco exports pra um HUD é o
over-engineering que este repo evita.

```js
export function fmtBytes(n)   // 0 -> "0", 999 -> "999", 1024 -> "1.0k", 2e6 -> "1.9M"
```

## F. Teste

Um bloco em `test.mjs`, no estilo flat de `assert` do arquivo: `fmtBytes` nas
fronteiras (`0`, `999`, `1024`, e um valor em MB).

**[rev]** Os outros dois asserts do rascunho foram cortados — um testava `array.pop()`,
o outro testava uma função que deixou de existir. YAGNI vale pra teste também.

## G. O HUD encolhe sozinho

A cidade roda numa janela de picture-in-picture do tamanho de um cartão de visita, então
o HUD tem que perder peças por prioridade em vez de vazar pra fora.

O que estava no caminho não era o breakpoint: eram os `<span class="sep">·</span>`
escritos à mão. Um separador escrito no markup sobrevive ao que ele separa — esconder a
branch deixaria um ponto órfão, e cada regra de `display:none` teria que esconder um
irmão junto. O ponto passa a ser gerado:

```css
#hud > *:not(:first-child)::before { content: "·"; margin-right: 10px; }
```

Agora cada item carrega o próprio separador e o leva embora quando some — inclusive o
`#r-status`, que já era escondido por `[data-ok="ok"]` e deixava um espaçamento
assimétrico antes disso.

A ordem no markup é a ordem de morte: `repo · branch · clock · perf · status`.

- `≤ 460px` — cai `#r-perf` (fps/heap: interessante, nunca essencial).
- `≤ 340px` — cai `#r-branch`.

`repo` e `clock` nunca caem: são as duas coisas que dizem *qual* cidade é essa e que ela
ainda está viva. `#r-status` também fica — só aparece quando algo quebrou.

CSS puro, zero JS: um `Document Picture-in-Picture` carrega o próprio viewport, então as
media queries valem dentro dele sem ninguém medir nada.

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
