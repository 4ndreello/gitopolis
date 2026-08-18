# Câmera de atenção

A câmera desliza sozinha para onde o repositório mudou e volta para o
enquadramento geral quando a cidade se acalma. Substitui o `autoRotate` mudo
por um giro que também sabe olhar.

Revisada contra o código antes de implementar; as decisões que mudaram por
causa dessa revisão estão marcadas com **[review]**.

## Sinal

`ingest()` em `src/main.js` é o único ponto onde um snapshot vira diff. Cada
file ganha um campo `attn` (0..1), setado para 1 ali em quatro casos:

- arquivo novo
- `bytes` mudou
- voltou de `dying`
- `dirty` flipou (é isto que captura o commit: todos os guindastes caindo juntos)

O loop decai `attn -= dt * 0.35`, ~3s até zerar. Um campo, um lugar de escrita,
nada persistido — igual ao resto da animação.

**[review] Deleção não usa `attn`.** Um arquivo apagado sai do Map em 0.67s
(`dying` avança 1.5/s), enquanto a atenção duraria 2.9s: a câmera perseguiria
um ponto que deixou de existir no meio do caminho, e o centroide saltaria.
Então `ingest()` empurra `{x, z, w: 1}` para um array `ghosts` no momento em que
marca `dying` — a posição é lida enquanto `layout.pos` ainda tem o plot. Os
ghosts decaem no mesmo ritmo e entram no foco junto com os vivos.

## Foco

`focus(pts)` vive em `src/city.js`, é puro e não importa nada — a mesma regra
que mantém `test.mjs` rodando em node puro.

```js
export function focus(pts) {  // pts = [{x, z, w}]
  let W = 0, cx = 0, cz = 0;
  for (const p of pts) { W += p.w; cx += p.x * p.w; cz += p.z * p.w; }
  if (!W) return null;
  cx /= W; cz /= W;
  let r = 0;
  for (const p of pts) r = Math.max(r, Math.hypot(p.x - cx, p.z - cz) * p.w);
  return { x: cx, z: cz, r };
}
```

O raio é o que dá o zoom: um arquivo salvo dá `r = 0` e a câmera fecha; um
commit espalhado dá `r` de meia cidade e ela abre sozinha. Voltar para o wide
é só o raio crescendo.

**[review] O raio é ponderado, não filtrado por limiar.** A versão original
ignorava pontos com `w <= 0.15`. Como um commit seta `attn = 1` em todo mundo
no mesmo frame, todos cruzariam 0.15 juntos em t=2.43s e o raio desabaria de
meia cidade para 0 num intervalo de 0.43s — um mergulho visível pouco antes de
a câmera voltar para casa. Multiplicar a distância pelo peso é contínuo e é uma
constante a menos.

**[review] Sem atenção, o alvo é home explicitamente.** A ideia de que o cold
open cairia sozinho no enquadramento padrão era falsa: `focus()` mede raio a
partir do centroide, `frameCamera()` mede `max(gw,gh)*0.72 + 6`, e o centroide
de distritos hasheados não é a origem. Medido, dava 0.53–0.80x da distância de
casa. `focus()` retornando `null` vira `homeTarget`/`homeDist` num ternário.

## Movimento

Nada de câmera nova. O alvo do `OrbitControls` e o comprimento do vetor
câmera→alvo são suavizados, o que preserva azimute, polar e o `autoRotate`
girando durante a viagem:

```js
_off.copy(camera.position).sub(controls.target);
controls.target.lerp(_want, 1 - Math.exp(-dt * 1.1));
_off.setLength(THREE.MathUtils.lerp(_off.length(), dist, 1 - Math.exp(-dt * 0.9)));
camera.position.copy(controls.target).add(_off);
```

`1 - Math.exp(-dt * k)` em vez de um alfa fixo: mesma suavização a 30 e a
144 fps. `controls.update()` recalcula o esférico a partir de
`camera.position - target` no topo de toda chamada, então escrever os dois
antes dele compõe com damping e autoRotate sem briga.

**[review] `_want` é um `Vector3` de escopo de módulo**, com o `y` de
`homeTarget` — `Vector3.lerp` contra um objeto sem `y` produz `NaN` e apaga o
render. E esse `y` importa: hoje é `min(6, r*0.1)`.

**[review] O gate é `controls.autoRotate`, não `idleTimer === 0`.**
`idleTimer` é 0 *durante* um drag (o handler `start` zera ele), então aquele
gate teria rodado o diretor exatamente enquanto o usuário arrasta. O que
realmente significa "ninguém tocou na câmera nos últimos 6s" é `autoRotate`.

**[review] O ângulo polar não é tocado** — só a distância. A prosa anterior
falava em "nível de rua"; a 38° e `dist` mínima a câmera fica a ~11 de altura,
um aéreo fechado. Baixar o polar quebraria o contrato medido no comentário de
`CAM_ANGLE` (a arca da lua está calibrada para esse pitch).

## Distância

`wantDist = distFor(f.r + 6)`, mesma fórmula e mesma folga de `frameCamera()`,
com clamp em `[homeDist * 0.35, homeDist]`.

**[review] O piso é relativo, não absoluto.** As unidades do mundo escalam com
√(número de arquivos) (`block = ceil(sqrt(maxDistrictCount))`), então um piso
fixo de 14 seria 0.57x da distância de casa num repo de 15 arquivos (zoom
invisível) e 0.18x num de 800 (mergulho). O teto em `homeDist` garante que a
atenção nunca enquadra mais aberto que o padrão.

## Home

`frameCamera()` grava `homeTarget` e `homeDist` em vez de escrever direto em
`camera.position`, e só dá snap uma vez.

**[review] O snap é condicionado a `layout.districts`**, não a "primeira
chamada": a chamada de escopo de módulo acontece antes do primeiro snapshot,
com `planCity([])`, e gastaria o snap enquadrando uma cidade vazia.

Isso conserta de lambuja um defeito atual: `frameCamera()` roda a cada
`layoutDirty`, então hoje a câmera teleporta toda vez que um arquivo some.

## Fog

`scene.fog.near` segue a distância suavizada; sem isso um close colocaria a
cidade inteira atrás de `fog.near`.

**[review] O diretor escreve `fogFar`, não `scene.fog.far`.** `applyTime()`
escreve `fog.far = fogFar * (1 - chuva*0.35)` todo frame e é a dona
documentada desse valor; escrever direto perderia o multiplicador de chuva.
`fogFar` também tem piso em `homeDist * 4.2`, senão um save num repo grande
dissolveria tudo menos o quarteirão focado.

## Ceilings conhecidos

- Zoom de roda de mouse compra 6s de trégua e depois é sobrescrito pela
  distância suavizada. Antes o zoom do usuário sobrevivia indefinidamente,
  porque `autoRotate` só mexia no azimute.
- O centroide de duas mudanças em cantos opostos aponta para o meio, que pode
  ser um parque vazio. Em commits grandes o raio já abre para o wide e o
  enquadramento sai certo de qualquer jeito.
- O reflow de layout documentado no CLAUDE.md (cruzar um limiar de contagem
  reembaralha as coordenadas) era mascarado pelo teleporte do `frameCamera()`.
  Com a câmera suavizada, um branch switch grande mostra a cidade deslizando
  sob uma câmera em movimento.

## Teste

`test.mjs` cobre `focus()`: lista vazia → `null`; um ponto → centro nele e
`r === 0`; dois pontos de peso igual → meio do caminho, `r` = metade do vão;
dois pontos fracos → contam no centroide e seguram o raio só na proporção do
peso; e uma varredura de `w` de 1 a 0 assertando que o raio nunca sobe — a
regressão do limiar removido.
