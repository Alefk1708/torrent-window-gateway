# Torrent Window Gateway

Gateway BitTorrent → HTTP Range para **conteúdo que você tem autorização para acessar e distribuir**. Foi desenhado para caber em uma única instância pequena do Koyeb, compartilhar o mesmo swarm entre vários espectadores e manter somente uma janela móvel de pieces no disco.

> Não é um clone do Real-Debrid, não contorna DRM, não inclui catálogo, contas pagas, busca de conteúdo, contorno de DRM ou armazenamento permanente. A transcodificação aqui é apenas sob demanda para as resoluções suportadas.

## Novidades na v1.1.0

- **Parar ao deixar de assistir**: o player envia `DELETE /api/v1/playbacks/:id?force=true` no evento `pagehide`, abortando streams/transcodificações ativos e permitindo que o torrent seja removido do disco em ~10s (`TORRENT_STOP_GRACE_SECONDS`) após o último espectador sair.
- **Troca de resolução sob demanda**: adicione `height=1080|720|480|320|144` ao endpoint `/api/v1/stream/...` para receber MP4 fragmentado (H.264/AAC) transcodificado em tempo real via ffmpeg. O player HTML expõe um seletor quando o container/codec não é nativamente suportado.

## O que está implementado

- magnet URI e upload de `.torrent`;
- resolução assíncrona de metadata e listagem de arquivos;
- `GET`/`HEAD` com `Range`, `206`, `Content-Range` e seek;
- **transcodificação sob demanda** (1080p/720p/480p/320p/144p) via ffmpeg, entregando MP4 fragmentado;
- player HTML incorporável por `<iframe>` com seletor de qualidade;
- sessões de reprodução com token aleatório, expiração e heartbeat;
- **teardown imediato ao sair da página** (`pagehide` → `DELETE ?force=true`);
- vários espectadores no mesmo torrent, com união das janelas necessárias;
- priorização dos pieces próximos a cada posição de reprodução;
- cache em disco por piece, descarte de dados que ficaram para trás e novo download após seek;
- limites globais, por IP, por sessão e por torrent;
- limpeza de sessões ociosas, coleta de lixo manual/automática e shutdown limpo;
- proteção administrativa por `API_KEY`, filtro de trackers/webseeds contra redes privadas, CORS e CSP;
- health/readiness, estatísticas, métricas Prometheus e OpenAPI 3.1;
- Docker multi-stage pronto para Koyeb (inclui ffmpeg).

## Como a janela móvel funciona

Cada piece verificado vira um arquivo separado em `/tmp`. Uma reprodução mantém, por padrão, 8 MiB atrás da posição atual e 48 MiB à frente. As janelas de todos os espectadores são unidas:

1. WebTorrent seleciona somente os intervalos ativos;
2. o stream lê o piece necessário e o entrega via HTTP;
3. pieces fora de todas as janelas recebem um pequeno período de graça;
4. o gateway marca esses pieces como ausentes, avisa peers compatíveis com BEP 54 e remove seus arquivos;
5. se alguém voltar ou buscar outra posição, os pieces são baixados novamente.

Isso limita o **cache residente**, mas não garante reprodução sem travamentos: disponibilidade de peers, velocidade do swarm, bitrate e seeks simultâneos continuam importando. BitTorrent trabalha com *pieces*, não com frames de vídeo.

## Limites realistas do plano grátis

Os padrões foram pensados para a instância gratuita atual do Koyeb (512 MB de RAM, 0,1 vCPU e 2 GB de SSD efêmero). Use como projeto pessoal, demonstração ou carga pequena. O serviço grátis pode entrar em scale-to-zero; o disco e as sessões podem desaparecer em reinícios/reagendamentos.

Com os padrões, espere poucos espectadores simultâneos. Para mais usuários, aumente CPU/RAM/disco e ajuste os limites. Transcodificar HEVC/DTS/TrueHD ou gerar HLS em tempo real não cabe de forma confiável nessa máquina, por isso o stream direto continua sendo o caminho mais barato; a transcodificação H.264/AAC é opcional e limitada por `MAX_TRANSCODES`.

## Compatibilidade de mídia

O gateway entrega os bytes originais. Em geral, navegadores aceitam MP4/WebM com codecs suportados pelo próprio navegador. Um arquivo `.mkv` pode ser listado e entregue, mas o player mostra aviso porque container/codecs como HEVC, DTS, TrueHD e legendas ASS frequentemente não funcionam em `<video>`.

## Execução local

Requisitos: Node.js 22+ (o contêiner usa Node 24).

```bash
cp .env.example .env
# troque API_KEY por: openssl rand -base64 36
set -a && . ./.env && set +a
npm ci --ignore-scripts
npm rebuild node-datachannel
npm run build
npm start
```

O install ignora hooks transitivos e recompila explicitamente o único addon nativo obrigatório; é o mesmo fluxo usado no Dockerfile.

Ou com Docker:

```bash
docker build -t torrent-window-gateway .
docker run --rm -p 8000:8000 \
  -e API_KEY="$(openssl rand -base64 36)" \
  torrent-window-gateway
```

Health check:

```bash
curl http://localhost:8000/health
```

## Fluxo de uso

Defina uma variável apenas para facilitar os exemplos:

```bash
BASE=http://localhost:8000
KEY='sua-chave-com-pelo-menos-24-bytes'
```

### 1. Adicionar um magnet

```bash
curl -sS -X POST "$BASE/api/v1/torrents" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  --data '{"magnet":"magnet:?xt=urn:btih:..."}'
```

Também é possível enviar um `.torrent`:

```bash
curl -sS -X POST "$BASE/api/v1/torrents" \
  -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/x-bittorrent' \
  --data-binary @video.torrent
```

A resposta é `202` para uma sessão nova ou `200` quando o infohash já existe. Consulte `torrent.state` até `ready`.

### 2. Ver arquivos/status

```bash
curl -sS "$BASE/api/v1/torrents/TORRENT_ID" \
  -H "Authorization: Bearer $KEY"
```

Escolha um `fileId` com `streamable: true`. `browserCompatible` é uma estimativa pelo container/extensão, não uma análise dos codecs.

### 3. Criar uma reprodução

```bash
curl -sS -X POST "$BASE/api/v1/playbacks" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  --data '{"torrentId":"TORRENT_ID","fileId":0}'
```

A resposta contém `playerUrl`, `streamUrl`, `token` e o HTML de `<iframe>`. Entregue ao espectador somente a URL temporária, nunca a `API_KEY` administrativa.

### 4. Seek/Range direto

```bash
curl -v "$STREAM_URL" -H 'Range: bytes=0-1048575' -o first-megabyte.bin
```

O player incluso atualiza a posição da janela via heartbeat. Um cliente próprio deve chamar `PATCH /api/v1/playbacks/:id` aproximadamente a cada 10–15 segundos.

## Endpoints

| Método | Rota | Autorização | Uso |
|---|---|---|---|
| `GET` | `/` | pública | identificação e links |
| `GET` | `/health` | pública | liveness do Koyeb |
| `GET` | `/ready` | pública | readiness após inicialização |
| `GET` | `/docs` | pública | referência curta em HTML |
| `GET` | `/openapi.yaml` | pública | contrato OpenAPI 3.1 |
| `GET` | `/api/v1/torrents` | admin | listar torrents |
| `POST` | `/api/v1/torrents` | admin | adicionar magnet ou `.torrent` |
| `GET` | `/api/v1/torrents/:id` | admin | status, arquivos, peers e cache |
| `GET` | `/api/v1/torrents/:id/files/:fileId` | admin | detalhes de um arquivo |
| `DELETE` | `/api/v1/torrents/:id?force=true` | admin | remover sessão/cache |
| `GET` | `/api/v1/playbacks` | admin | listar reproduções |
| `POST` | `/api/v1/playbacks` | admin | criar URL/token temporário |
| `GET` | `/api/v1/playbacks/:id` | token ou admin | estado da reprodução |
| `PATCH` | `/api/v1/playbacks/:id` | token ou admin | heartbeat/posição |
| `DELETE` | `/api/v1/playbacks/:id` | token ou admin | encerrar reprodução |
| `GET`, `HEAD` | `/api/v1/stream/:torrentId/:fileId` | token ou admin | stream HTTP Range |
| `GET` | `/player/:torrentId/:fileId` | token | player incorporável |
| `GET` | `/api/v1/stats` | admin | consumo e limites |
| `POST` | `/api/v1/admin/gc` | admin | executar descarte imediato |
| `GET` | `/metrics` | admin | métricas Prometheus |

Admin aceita `Authorization: Bearer <API_KEY>` ou `X-API-Key`. O player usa `playback` e `token` na query; chamadas programáticas podem usar `X-Playback-Token` ou Bearer. Veja [docs/openapi.yaml](docs/openapi.yaml) para parâmetros e respostas.

## Deploy no Koyeb

O caminho mais simples é publicar este diretório em um repositório GitHub e criar um Web Service com builder **Dockerfile**:

1. crie um App/Service no Koyeb a partir do repositório;
2. selecione o instance type `Free` e uma região onde ele esteja disponível;
3. exponha a porta HTTP `8000`, rota `/`;
4. configure o health check HTTP em `/health` na porta `8000`;
5. crie `API_KEY` como secret, com no mínimo 24 bytes;
6. mantenha `PORT=8000`, `HOST=0.0.0.0` e `CACHE_DIR=/tmp/torrent-window-gateway`;
7. opcionalmente defina `PUBLIC_BASE_URL=https://seu-app.koyeb.app` e restrinja `CORS_ORIGINS`/`FRAME_ANCESTORS`.

O passo a passo e os ajustes recomendados estão em [docs/KOYEB.md](docs/KOYEB.md).

## Variáveis importantes

| Variável | Padrão | Significado |
|---|---:|---|
| `API_KEY` | obrigatória | chave admin de pelo menos 24 bytes |
| `CACHE_MAX_MB` | `768` | teto global aproximado do cache |
| `TORRENT_CACHE_MAX_MB` | `512` | teto aproximado por torrent |
| `WINDOW_AHEAD_MB` | `48` | bytes priorizados à frente por janela |
| `WINDOW_BEHIND_MB` | `8` | bytes retidos atrás por janela |
| `MAX_TORRENTS` | `3` | sessões de torrent simultâneas |
| `MAX_PLAYBACKS` | `6` | sessões de player simultâneas |
| `MAX_CONCURRENT_STREAMS` | `6` | respostas HTTP de mídia abertas |
| `MAX_TRANSCODES` | `2` | jobs ffmpeg simultâneos (0 desliga) |
| `MAX_PEER_CONNECTIONS` | `24` | conexões BitTorrent do cliente |
| `STREAM_MAX_MBIT` | `20` | limite por resposta; `0` desliga |
| `UPLOAD_SLOTS` | `0` | upload/seeding desativado por padrão |
| `PLAYBACK_IDLE_SECONDS` | `90` | expiração sem heartbeat/stream |
| `TORRENT_IDLE_MINUTES` | `15` | remoção de torrent sem uso |
| `TORRENT_STOP_GRACE_SECONDS` | `10` | remoção rápida após último espectador sair |
| `TRANSCODE_ENABLED` | `true` | ativa/desativa transcodificação |
| `FFMPEG_PATH` | `ffmpeg` | caminho do binário ffmpeg |
| `CORS_ORIGINS` | `*` | origens permitidas, separadas por vírgula |
| `FRAME_ANCESTORS` | `*` | quem pode incorporar o player |
| `BIND_PLAYBACK_TO_IP` | `false` | vincula token ao IP original |

Todas as opções e faixas aceitas estão em [.env.example](.env.example).

## Segurança e operação

- Trate `API_KEY` como segredo e nunca a coloque no frontend.
- O token de playback aparece na URL para funcionar em `<video>`/`iframe`; ele é aleatório, curto, temporário e páginas usam `Referrer-Policy: no-referrer`. Mesmo assim, evite logs de query string em proxies.
- Por padrão, trackers e webseeds que resolvem para loopback/redes privadas são descartados. `xs`, `as` e peers explícitos do magnet também são removidos.
- Endereços privados/reservados recebidos como peers também são bloqueados antes da conexão; mantenha `ALLOW_PRIVATE_NETWORKS=false` em serviços públicos.
- `ALLOW_WEB_SEEDS=false` evita que o servidor faça fetch de URLs arbitrárias como fonte de conteúdo.
- O cache é efêmero e apagado na inicialização/shutdown. Não use volume persistente para esta estratégia.
- Por segurança, `CACHE_DIR` deve ser um subdiretório do diretório temporário do sistema; ele é removido recursivamente pelo serviço.
- O limite é aproximado: pieces já em download e a soma de janelas ativas podem causar picos temporários.
- O projeto fixa a versão do WebTorrent porque a remoção segura de pieces usa APIs internas verificadas. Atualize somente após testes.
- O override documentado em `vendor/ip-safe` remove a API transitiva sem correção para CVE-2024-29415; `npm audit --omit=dev` deve continuar limpo.
- Não há banco: executar múltiplas réplicas criaria swarms/caches independentes e invalidaria tokens entre instâncias. Este projeto é deliberadamente single-instance.

## Desenvolvimento e testes

```bash
npm ci --ignore-scripts
npm rebuild node-datachannel
npm run check
npm test
npm run build
```

Os testes cobrem parsing de `Range`, autenticação/health, bloqueio de peers privados, união das janelas e escrita/leitura/descarte do chunk store. Há também um teste local end-to-end, sem conteúdo externo, que cria seu próprio swarm, baixa um piece, o remove e confirma o novo download:

```bash
npm run test:integration
```

## Documentação adicional

- [Arquitetura e invariantes](docs/ARCHITECTURE.md)
- [Deploy e diagnóstico no Koyeb](docs/KOYEB.md)
- [OpenAPI 3.1](docs/openapi.yaml)
- [Cliente Node de exemplo](examples/client.mjs)
- [Iframe de exemplo](examples/embed.html)

## Licença

MIT. Você é responsável por cumprir direitos autorais, termos do tracker e leis aplicáveis.
