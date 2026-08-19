# Revisão técnica — Torrent Window Gateway 1.1.0

## Resultado

O gateway recebido **já possuía a base correta** para encerrar playbacks: `AbortController` por stream, `TranscodeManager.killForPlayback()`, `DELETE ?force=true`, janela móvel de pieces e remoção da sessão torrent quando não há mais uso. A revisão confirmou esse fluxo e corrigiu os pontos que ainda prejudicavam a integração e a troca de qualidade.

A versão do pacote/API foi alinhada para **1.1.0**.

## Encerramento quando a pessoa para de assistir

O fluxo funcional é:

1. O player recebe `pagehide` ou o StreamBR fecha o modal.
2. É enviado `DELETE /api/v1/playbacks/:id?force=true` com o token da reprodução.
3. `TorrentManager.abortPlaybackWork()` aborta todos os HTTP streams daquele playback e chama `TranscodeManager.killForPlayback()`.
4. Cada processo FFmpeg recebe `SIGTERM`; se ainda estiver vivo após 3 segundos, recebe `SIGKILL`.
5. `deletePlaybackInternal()` remove a janela daquele espectador e decrementa o uso da sessão.
6. Sem outros espectadores/streams/janelas, a manutenção remove o torrent e o cache após `TORRENT_STOP_GRACE_SECONDS`, agora **10 segundos por padrão**.

Importante: WebTorrent roda dentro do processo do gateway e uma sessão de torrent pode ser compartilhada por vários espectadores. Por isso o gateway não destrói o swarm inteiro ao sair um único usuário se ainda houver outro playback usando o mesmo torrent. O processo externo que é encerrado imediatamente por playback é o FFmpeg.

## Resoluções e transcodificação

O endpoint aceita:

```text
GET /api/v1/stream/:torrentId/:fileId?playback=...&token=...&height=720&start=0
```

`resolution=720` também é aceito como alias de `height`.

Resoluções permitidas: **1080, 720, 480, 320 e 144**. O FFmpeg entrega MP4 fragmentado com H.264/AAC e nunca faz upscale acima da resolução da origem.

Foram definidos perfis próprios para cada degrau:

| Altura | CRF | Maxrate vídeo | Buffer | Áudio |
|---:|---:|---:|---:|---:|
| 1080p | 23 | 5 Mbit/s | 10 Mbit | 128 kbit/s |
| 720p | 24 | 2.8 Mbit/s | 5.6 Mbit | 128 kbit/s |
| 480p | 25 | 1.4 Mbit/s | 2.8 Mbit | 96 kbit/s |
| 320p | 27 | 800 kbit/s | 1.6 Mbit | 64 kbit/s |
| 144p | 30 | 350 kbit/s | 700 kbit | 48 kbit/s |

O `POST /api/v1/playbacks` retorna `transcodeHeights` quando FFmpeg está habilitado e disponível. O player HTML mostra `Original` e os cinco degraus. Ao trocar de qualidade, ele conserva a posição absoluta e reinicia o FFmpeg usando `start`.

## Correção importante na contagem de streams

Antes desta revisão, uma transcodificação podia consumir dois slots do mesmo playback: um para a resposta externa do FFmpeg e outro para a leitura HTTP interna do arquivo torrent feita pelo próprio FFmpeg. Com `MAX_STREAMS_PER_PLAYBACK=2`, uma única transcodificação saturava o limite e trocas rápidas de qualidade podiam resultar em `429 PLAYBACK_STREAM_LIMIT_REACHED`.

Agora somente o stream torrent interno contabiliza o slot de mídia. A resposta externa do FFmpeg mantém seu próprio `AbortController`, mas não duplica a contabilização.

## Teste de FFmpeg executado

Foi gerada uma entrada sintética 1920×1080 e executado o mesmo filtro/perfis usados pelo gateway. O `ffprobe` confirmou:

```text
1080p -> H.264 1920x1080
720p  -> H.264 1280x720
480p  -> H.264 854x480
320p  -> H.264 568x320
144p  -> H.264 256x144
```

Também foram validados sintaticamente 25 arquivos `.ts`/`.tsx` sem erro de sintaxe.

## Configuração recomendada

```env
API_KEY=UMA_CHAVE_FORTE_COM_PELO_MENOS_24_CARACTERES
TORRENT_STOP_GRACE_SECONDS=10
TRANSCODE_ENABLED=true
FFMPEG_PATH=ffmpeg
MAX_TRANSCODES=2
```

A mesma `API_KEY` deve ser configurada como `TORRENT_GATEWAY_API_KEY` no backend do StreamBR.

O Dockerfile já instala FFmpeg. Se o player for incorporado pelo StreamBR e você não usar `FRAME_ANCESTORS=*`, configure `FRAME_ANCESTORS` para permitir a origem do seu site.

Em máquinas com pouca CPU, 1080p/720p em tempo real podem não acompanhar a reprodução. Isso é limitação de recursos, não do contrato da API; nesses casos reduza `MAX_TRANSCODES`, prefira stream original quando compatível ou use uma instância mais forte.

## Validação completa no ambiente de deploy

Este sandbox não contém `node_modules`, então a suite Node/Fastify completa não foi executada aqui. No ambiente com dependências, rode:

```bash
npm ci
npm run check
npm test
npm run build
```

Para um teste ponta a ponta, reproduza conteúdo torrent autorizado, troque 720p ↔ 480p, faça seek e feche o player durante uma transcodificação. Consulte `/api/v1/stats`: o job de transcode deve cair imediatamente e a sessão torrent deve desaparecer após a graça curta quando for o último espectador.
