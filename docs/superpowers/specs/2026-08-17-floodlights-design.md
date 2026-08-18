# Holofotes: torres lavadas de baixo à noite

Data: 2026-08-17
Estado: aprovado, não implementado

## Problema

De noite a cidade some. As janelas acesas (`litAt`) e as cabeças de poste
(`streetMat` + `nightK`) são os únicos pontos de luz, e as duas são pequenas e
ocre. As torres — a parte mais cara e mais alta da cena — ficam como silhuetas
pretas sobre céu preto. A screenshot que abriu essa discussão mostra duas torres
com janelas laranja e nada mais: nenhum volume, nenhuma aresta, nenhuma base.

Falta uma fonte de luz que descreva a *forma* do prédio em vez de pontilhar a
fachada.

## O que se constrói

Holofotes de chão nas quatro faces de cada torre, apontando para cima, que
acendem junto com os postes e lavam o terço inferior da fachada com luz
branco-azulada.

### Quem ganha

`!house && floors > 8` — exatamente o mesmo teste que já decide se o prédio
ganha `cap` em `makeBuilding`. Nenhum limiar novo é inventado. Como
`updateBuilding` já destrói e recria o prédio quando `floorsOf(bytes)` muda, um
arquivo que cresce e vira torre ganha os holofotes de graça, e um que encolhe os
perde.

Casas e blocos baixos ficam escuros de propósito: é o contraste que faz a torre
ler como torre.

### Nada de luz de verdade

Nenhum `THREE.SpotLight`. Cada luz real custa em todo material iluminado da cena
e recompila shaders quando a contagem muda; vinte torres derrubariam o fps. O
efeito é feito com os dois truques que a cidade já usa:

- **o texel de glow** (`TEX_GLOW` + `emissiveMap`), que já acende cabeça de poste
  e farol de carro sem luz nenhuma;
- **o quad aditivo** (`poolMat`), que já pinta a poça de luz no asfalto.

### Peças novas

Em `src/props.js`, ao lado das que já existem:

- `GEO_FLOOD` — quatro caixinhas *merged* numa geometria só, uma no meio de cada
  face, encostadas do lado de fora da parede, lente virada para cima. Cor de
  vértice escura no corpo, texel branco do strip de glow na lente. Usa
  `streetMat`, o mesmo material dos postes.
- `GEO_WASH` — quatro quads verticais *merged* formando uma caixa aberta, unit,
  com uv 0..1 na vertical em cada face.
- `mkWashTex()` — vizinha de `mkPoolTex()`. Gradiente vertical, forte embaixo,
  zero no topo, **e fade nas bordas laterais**. Sem o fade lateral o quad
  aparece como um retângulo colado na parede; é o mesmo motivo pelo qual
  `mkPoolTex` termina em alpha zero na borda.

Em `src/main.js`:

- `washMat` — `MeshBasicMaterial`, cor `0xbfd6ff`, `blending: AdditiveBlending`,
  `transparent: true`, `depthWrite: false`, `fog: false`, `opacity: 0`.

A cor é fria de propósito. As janelas, os postes, as poças e os faróis são todos
ocre; um holofote ocre funde com a janela acesa que está logo acima dele. O
branco-azulado separa "luz que a cidade aponta para o prédio" de "luz que sai de
dentro do prédio".

### Como se move

Os dois meshes são filhos do `group` do prédio, criados em `makeBuilding` junto
com `cap`. Sendo filhos, nascem, crescem, e são removidos com o prédio sem
nenhum código de ciclo de vida novo.

Em `updateBuilding`, junto com o resto do corpo:

```
wash.scale.set(b.w + 0.024, h / 3, b.d + 0.024)
flood.scale.set(b.w, 1, b.d)
```

O `+0.024` afasta a lavagem 0.012 da parede em cada lado — coplanar com a
fachada ela z-fighta, pelo mesmo motivo documentado na pilha de `Y_*`. A altura
`h / 3` acompanha `h`, então durante o crescimento a lavagem sobe com a obra.

Em `tick`, uma linha ao lado de `streetMat.emissiveIntensity = night`:

```
washMat.opacity = night * 0.55
```

e os meshes de wash escondidos quando `night < 0.01` — um quad aditivo com
opacidade zero ainda custa um draw call, que é exatamente o que o comentário do
`pools` já registra.

Os fixtures não precisam de linha nenhuma: `streetMat.emissiveIntensity = night`
já existe e já os acende.

### O que o holofote *não* faz

Não passa por `litAt`. Holofote é iluminação pública, não é alguém no escritório
apertando o interruptor: ele acende com o poste, na rampa de duas horas do
`nightK`, e todos acendem juntos.

Não reage a evento (`dirty`, `done`, `born`). O andaime e o guindaste já contam
essa história, e as quatro luzes ficam no meio das faces, onde os quatro postes
de andaime (nos cantos) não passam.

## Custo

- +2 draw calls por torre. Zero luzes, zero recompilação de shader.
- `src/city.js` não muda, logo `test.mjs` não muda.

## Ceilings aceitos

- `flood.scale.set(b.w, 1, b.d)` é não-uniforme, e `b.w`/`b.d` variam entre 0.70
  e 0.92, então as caixinhas são espremidas até ~10% conforme o prédio. Invisível
  nesse tamanho. Se algum dia incomodar, o conserto é posicionar quatro meshes
  separados em vez de escalar um merged. Vai marcado com um comentário
  `ponytail:`.
- A lavagem é um quad plano, não um cone: ela não projeta sombra, não é ocluída
  pelo prédio vizinho, e não escurece quando outra torre está na frente. É
  pintura aditiva, e a alternativa é a luz real que esse spec recusa.

## Verificação

`src/city.js` não muda, então não há o que asserir em `test.mjs`. A checagem é
visual e headless, do jeito que o CLAUDE.md já descreve:

- `window.__toggle("flood")` novo, ao lado de `dust`/`cars`/`clouds`, para A/B
  na mesma cena.
- `window.__city()` ganha `floods` (contagem de torres iluminadas), para
  confirmar que o número bate com o número de prédios com `cap`.
- Screenshot com `window.__time(0.9)` (noite congelada) antes e depois.

## Fora de escopo

- Poça aditiva no chão sob cada fixture. A lavagem já ilumina a base; entra se a
  base ficar seca.
- Holofote reagindo a evento de arquivo.
- Cor por distrito ou por padrão de fachada.
