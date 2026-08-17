# Mundo vivo — design

Data: 2026-08-16
Estado: aprovado, pronto pra virar plano de implementação

## Objetivo

Tirar o projeto do estado de PoC e transformá-lo num **mundo de fundo que reage**:
uma janela pequena, sempre aberta num canto, mostrando a cidade do repositório
enquanto o dia passa sozinho.

Três coisas mudam:

1. O dia passa automaticamente — 5 minutos reais = 1 dia de jogo, de 00:00 a 23:59.
2. Dá pra escolher o projeto pela interface, sem reiniciar o servidor.
3. A janela fica pequena: o canvas ocupa tudo e a HUD vira um overlay mínimo.

E a cidade ganha vida ambiente: janelas acendendo prédio a prédio, trânsito com
ritmo de hora, pedestres, e um céu com estrelas, lua e clima.

## Não-objetivos

- **Sem placar, XP, níveis ou conquistas nesta entrega.** A arquitetura não fecha
  a porta pra isso (ver "Porta aberta pro level"), mas nada disso é construído agora.
- Sem múltiplos repositórios simultâneos na mesma cena.
- Sem assets. A regra do projeto continua: toda textura é desenhada em canvas em
  tempo de execução, toda malha é geometria procedural do three.js.

## Invariante que continua valendo

**A cidade é uma projeção pura da árvore de trabalho e nunca é persistida.**

Tudo que este design adiciona respeita isso:

- O relógio é derivado de `Date.now()`, sem epoch salvo em lugar nenhum.
- O clima é derivado do índice do dia de jogo, que também vem de `Date.now()`.
- As janelas acesas são derivadas do caminho do arquivo e da hora.

Nenhum arquivo de save, nenhum cursor de "último commit processado". Reiniciar
produz o mesmo mundo.

## Arquitetura

Continua sendo dois processos, e a divisão não muda:

```
server.mjs  ── git + fs ──►  SSE /events  ──►  src/main.js (three.js)  ──►  canvas
             (node)          snapshot completo   diffs contra o frame anterior
```

O que muda:

- `src/city.js` ganha as funções puras novas (relógio, luzes, trânsito, clima).
  Continua sem importar nada, continua testável em node puro.
- `src/main.js` recebe a vida visual nova, cada peça encostada no sistema que ela
  imita: chuva ao lado da poeira, estrelas embaixo do domo do céu, pedestres ao lado
  do trânsito. Vai pra cerca de 980 linhas, ainda dividido em seções.
- `server.mjs` ganha listagem de repositórios e troca de repositório ativo.

**Nenhum arquivo novo.** Uma versão anterior deste design punha pedestres, céu e
chuva num `src/life.js`. Foi descartado: os três não têm acoplamento nenhum entre si,
e o irmão real de cada um já mora no `main.js`. Uma fronteira de módulo entre um
sistema e seu gêmeo é justamente como os dois divergem com o tempo. A fronteira que
importa neste projeto é a pureza do `city.js`, não o tamanho do `main.js`.

### Alternativas descartadas

**Relógio no servidor.** O servidor mandaria a hora dentro do snapshot. Isso mata a
idempotência do snapshot: hoje o `broadcast` só dispara quando algo muda, e um
relógio exigiria um tick contínuo ou um segundo canal. Custo alto, ganho zero — o
cliente sabe que horas são.

**Refatorar pra entity/system agora, antecipando o level.** Registro de sistemas,
event bus, tudo plugável. É desnecessário: `git log` já é a história acumulada, então
level vira uma função pura a mais em `city.js`. Nenhuma peça deste design precisaria
mudar pra acomodar isso depois.

## Componentes

### 1. Relógio — `src/city.js`

Funções puras novas:

- `DAY_MS = 300_000` — 5 minutos reais por dia de jogo.
- `dayT(now)` → `0..1`. Implementação: `(now % DAY_MS) / DAY_MS`. Sem estado, sem
  epoch guardado; um reload cai no mesmo horário que a aba antiga estaria mostrando.
- `clockLabel(t)` → `"07:42"`. Formata `t` como hora de 24h com zero à esquerda.
- `dayIndex(now)` → `Math.floor(now / DAY_MS)`. Identidade do dia de jogo, usada
  como semente do clima.

O `applyTime(t)` que já existe em `main.js` não muda: os keyframes atuais já mapeiam
`t=0` em meia-noite, `0.25` no amanhecer, `0.5` no meio-dia e `0.75` no anoitecer.

O slider `hora` sai do HTML. No lugar entra `window.__time(t)`, que congela o relógio
num valor fixo — é o que permite tirar screenshot de uma hora específica em teste
headless. Chamar `window.__time(null)` volta pro relógio automático.

### 2. Seletor de projeto — `server.mjs`

O argumento de linha de comando passa a ser tratado como **raiz**:

- Se `<path>/.git` existe, `<path>` entra na lista.
- Todo subdiretório direto de `<path>` que tenha `.git` também entra.

Assim `node server.mjs ~/Desktop/dev` lista todos os projetos, e
`node server.mjs .` dentro de um repositório continua funcionando como hoje.

Endpoints:

- `GET /repos` → `["nome", ...]`, a lista acima. Só nomes atravessam a rede;
  caminho nenhum sai do servidor.
- `GET /events?repo=<name>` → SSE daquele repositório. Sem o parâmetro, usa o primeiro.

**Validação obrigatória:** o valor de `repo` é procurado na lista já construída. Se
não estiver lá, responde 400. O parâmetro nunca é concatenado num caminho — isso é o
que impede path traversal pela query string.

Um repositório ativo por vez, global ao processo. Trocar fecha o `fs.watch` antigo,
abre o novo e zera `lastPayload`. Isso recebe um comentário `ponytail:` marcando o
teto: se duas janelas com projetos diferentes ao mesmo tempo passarem a importar,
vira estado por cliente.

No cliente, a troca **não** limpa o estado local. O `ingest` já marca como `dying`
todo arquivo que sumiu do snapshot, então a cidade antiga desmorona sozinha enquanto
a nova sobe sob andaimes. A transição sai de graça.

### 3. Janelas acendendo — `src/city.js` + `src/main.js`

Hoje `applyTime` escreve `emissiveIntensity` em `allFacadeMats`, então a cidade
inteira acende no mesmo instante.

Passa a ser por prédio. Cada prédio clona sua material de fachada uma vez, em
`makeBuilding`. Isso não custa draw call nenhuma: já existe um mesh por prédio.

`litAt(path, t)` → `0..1`, puro. A partir de `hash(path)` deriva:

- hora de acender, entre 17h e 20h;
- hora de apagar, entre 21h e 03h;
- uma fração dos prédios que nunca acende.

Casas (`isHouse`) não têm mapa emissivo hoje e continuam apagadas.

Comentário `ponytail:` no clone de material, marcando o teto: se um repositório de
uns 2 mil arquivos engasgar, o caminho de upgrade é instanciar por par
(padrão, cor) em vez de um mesh por prédio.

### 4. Ritmo do trânsito — `src/city.js` + `src/main.js`

`trafficAt(t)` → `0..1`, puro: fundo do poço por volta das 3h, picos às 8h e às 18h,
patamar médio no meio do dia.

Aplicado de duas formas em `updateCars`: `cars.count = Math.round(max * densidade)`
e um multiplicador na velocidade.

**Esconder instância é feito por `count`, nunca por `makeScale(0, 0, 0)`.** Matriz
de escala zero tem matriz normal singular, e o driver desenha triângulos de lixo a
partir dela — foi exatamente a origem dos quads brancos documentados no CLAUDE.md.

### 5. Pedestres — `src/main.js`

Um `InstancedMesh` de caixinhas andando pelo perímetro das placas de quadra. Cada
pedestre guarda quadra, posição no perímetro e velocidade, igual ao esquema de faixas
dos carros.

A densidade vem de `trafficAt` com um deslocamento de fase: gente aparece um pouco
antes do carro de manhã e some um pouco depois à noite. Mesma regra de `count`.

Reconstruído junto com o chão, dentro de `rebuildGround`.

### 6. Céu e clima — `src/main.js`

**Estrelas.** Um `Points` distribuído numa esfera grande, com `fog: false` e
`depthWrite: false`. A opacidade acompanha o fator de noite derivado de `t`.

**Lua.** Um mesh pequeno e claro posicionado oposto ao vetor do sol, visível só à
noite.

**Clima.** `weatherAt(dayIndex)` → `{ nublado, chuva }`, ambos `0..1`, determinístico
via `rand01` sobre o índice do dia. Mesmo dia de jogo produz sempre o mesmo clima.

- `nublado` escala a quantidade e a opacidade das nuvens que já existem.
- `chuva` acrescenta um `Points` caindo, fecha a neblina e reduz a intensidade do sol.

Por ser derivado do índice do dia, o clima continua sendo projeção pura: nada é
sorteado e guardado.

### 7. HUD — `index.html`

O canvas passa a ocupar a janela inteira (`position: fixed; inset: 0`). Por cima
flutua um único bloco no canto superior esquerdo:

```
repo ▾ · branch · 07:42
```

- `repo` é um `<select>` alimentado por `GET /repos`, estilizado plano.
- `branch` e o relógio são texto.

O slider `ângulo` também sai: o ângulo fica fixo em 52° e o OrbitControls já permite
arrastar. `frameCamera` passa a usar a constante em vez de ler o input.

`arquivos`, `distritos`, `obras` e `fps` saem do DOM e passam a viver só em
`window.__city()`, que ganha o campo `fps`.

## Fluxo de dados

Sem mudança estrutural. O servidor manda snapshot completo; o cliente compara com o
frame anterior e anima a diferença. O relógio e o clima são um segundo eixo de
entrada, puramente local, que não passa pelo SSE.

## Erros

- **Repositório inválido na query.** 400, e o cliente mantém o repositório atual.
- **`git` falha durante um scan.** Comportamento atual preservado: loga e mantém o
  último snapshot bom.
- **Diretório raiz sem nenhum repositório.** O servidor sobe, `/repos` devolve lista
  vazia, e a HUD mostra o select vazio em vez de quebrar.
- **SSE cai.** Comportamento atual preservado: o status vira "sem conexão" e o
  `EventSource` reconecta sozinho.

## Testes

`test.mjs` continua sendo um arquivo plano de `assert`, sem framework. Asserts novos,
todos sobre funções puras de `city.js`:

- `dayT` dá a volta: `dayT(t)` e `dayT(t + DAY_MS)` são iguais; o resultado fica
  sempre em `[0, 1)`.
- `clockLabel` nos limites: `0` → `"00:00"`, `0.5` → `"12:00"`, e o topo do intervalo
  nunca produz `"24:00"`.
- `litAt` está apagado ao meio-dia e aceso às 23h para um caminho que acende.
- `trafficAt(3h)` é menor que `trafficAt(8h)`.
- `weatherAt` é determinístico: duas chamadas com o mesmo `dayIndex` são iguais.

As asserções de layout que já existem continuam valendo sem alteração — nada aqui
toca `planCity`.

## Arquivos afetados

| Arquivo | Mudança |
|---|---|
| `src/city.js` | funções puras novas: relógio, luzes, trânsito, clima |
| `src/main.js` | relógio automático, clone de material por prédio, densidade de carros, pedestres, estrelas, lua, chuva, sliders removidos |
| `server.mjs` | `/repos`, `?repo=`, troca de repositório ativo |
| `index.html` | canvas em tela cheia, overlay mínimo com select |
| `test.mjs` | asserts das funções puras novas |

## Porta aberta pro level

Level e XP precisam de história acumulada — mas `git log` **é** a história acumulada.
XP derivado de `git log --numstat` continua sendo projeção pura: sem save file, sem
cursor, invariante intacta. Um rebase muda o nível, e isso está correto pela mesma
lógica que faz um rebase remodelar a cidade.

Quando isso for construído, o caminho é: `git log --numstat` no servidor → campo novo
e opcional no snapshot → função pura em `city.js` que o traduz em nível. O cliente já
ignora campos que não conhece. Nenhum componente deste design precisa mudar.
