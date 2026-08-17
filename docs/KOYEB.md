# Deploy no Koyeb

## Perfil recomendado para o plano grátis

Use **uma única instância Free**, builder Dockerfile, porta HTTP `8000` e health check `/health`. Os defaults do projeto foram limitados para o perfil gratuito atual, mas BitTorrent é sensível a CPU, memória, disco, rede e disponibilidade externa de peers; não há garantia de reprodução contínua.

O armazenamento local do runtime é tratado como efêmero. Não há migração de sessões: após scale-to-zero, reinício ou reagendamento, adicione novamente o torrent e crie novos playbacks.

## Pelo painel

1. Publique o projeto em um repositório GitHub.
2. No Koyeb, selecione **Create Web Service** e o repositório.
3. Use o builder **Dockerfile** e a raiz que contém este `Dockerfile`.
4. Escolha uma região/instância onde o tipo **Free** esteja disponível.
5. Adicione uma porta HTTP `8000` com rota `/`.
6. Configure health check HTTP: porta `8000`, path `/health`.
7. Crie um Secret `torrent-gateway-api-key` e exponha-o como `API_KEY`.
8. Adicione as variáveis abaixo.
9. Faça o deploy e teste `https://SEU-SUBDOMINIO.koyeb.app/health`.

## Pela CLI

Com a CLI autenticada e o repositório já publicado, substitua `SEU_USUARIO/SEU_REPOSITORIO`:

```bash
openssl rand -base64 36 | \
  koyeb secrets create torrent-gateway-api-key --value-from-stdin

koyeb apps init torrent-window-gateway \
  --git github.com/SEU_USUARIO/SEU_REPOSITORIO \
  --git-branch main \
  --git-builder docker \
  --instance-type free \
  --regions was \
  --ports 8000:http \
  --routes /:8000 \
  --checks 8000:http:/health \
  --checks-grace-period 8000=20 \
  --scale 1 \
  --env 'API_KEY={{secret.torrent-gateway-api-key}}' \
  --env PORT=8000 \
  --env HOST=0.0.0.0 \
  --env CACHE_DIR=/tmp/torrent-window-gateway \
  --wait
```

Use `--regions fra` no lugar de `was` se Frankfurt for a opção disponível/preferida. Depois configure `PUBLIC_BASE_URL`, `CORS_ORIGINS` e `FRAME_ANCESTORS` com o domínio final.

## Variáveis sugeridas

```dotenv
PORT=8000
HOST=0.0.0.0
CACHE_DIR=/tmp/torrent-window-gateway
CACHE_MAX_MB=768
TORRENT_CACHE_MAX_MB=512
WINDOW_AHEAD_MB=48
WINDOW_BEHIND_MB=8
MAX_TORRENTS=3
MAX_PLAYBACKS=6
MAX_CONCURRENT_STREAMS=6
MAX_PEER_CONNECTIONS=24
STREAM_MAX_MBIT=20
UPLOAD_SLOTS=0
ALLOW_WEB_SEEDS=false
LOG_LEVEL=info
```

Defina ainda:

```dotenv
PUBLIC_BASE_URL=https://SEU-SUBDOMINIO.koyeb.app
CORS_ORIGINS=https://SEU-SITE.example
FRAME_ANCESTORS=https://SEU-SITE.example
```

Se o player será aberto diretamente e não incorporado, use `FRAME_ANCESTORS='none'`. Se houver vários sites autorizados, separe os valores de `FRAME_ANCESTORS` por espaço e `CORS_ORIGINS` por vírgula.

## Teste pós-deploy

```bash
BASE=https://SEU-SUBDOMINIO.koyeb.app
KEY='a-chave-configurada-no-secret'

curl -fsS "$BASE/health"
curl -fsS "$BASE/ready"
curl -fsS "$BASE/api/v1/stats" -H "Authorization: Bearer $KEY"
```

Depois use um torrent pequeno, legal e bem semeado para validar metadata, um Range curto e um seek.

## Diagnóstico

### Serviço não fica saudável

- confirme `PORT=8000` e a porta exposta no Service;
- confirme `HOST=0.0.0.0` (não `127.0.0.1`);
- confira se `API_KEY` tem ao menos 24 bytes;
- verifique se o health check aponta para `/health`;
- leia o primeiro erro nos runtime logs.

### Processo reinicia ou aparece OOM

- reduza `MAX_PEER_CONNECTIONS` para 12–16;
- reduza `MAX_PLAYBACKS`/`MAX_CONCURRENT_STREAMS`;
- reduza `WINDOW_AHEAD_MB` e `STREAM_CHUNK_KB`;
- mantenha `UPLOAD_SLOTS=0`;
- não adicione FFmpeg à instância grátis.

### Disco enche

- reduza `CACHE_MAX_MB` e `TORRENT_CACHE_MAX_MB`;
- reduza o período de graça;
- consulte `/api/v1/stats` e execute `POST /api/v1/admin/gc`;
- remova torrents ociosos ou use `force=true` quando souber que pode interromper viewers.

### Poucos peers ou metadata demora

- valide o torrent fora do gateway;
- trackers privados/locais são bloqueados por padrão;
- a rede do provedor pode não permitir toda forma de conectividade inbound/NAT;
- DHT/tracker não garantem que exista um peer rápido com o intervalo desejado.

### MP4 funciona, MKV não

Isso costuma ser compatibilidade do navegador com container/codec, não problema do Range. O projeto não remuxa nem transcodifica. Use mídia compatível com o navegador ou faça remux/transcode em infraestrutura separada.

## Scale-to-zero

Tráfego do player/heartbeat mantém o serviço ativo enquanto alguém assiste. Depois de inativo, o serviço grátis pode dormir. O primeiro acesso seguinte pode ter cold start e o cache anterior não deve ser considerado durável.

## Atualizações

As versões runtime são fixadas no `package.json`. Dependabot/Renovate pode abrir propostas, mas não faça atualização automática do WebTorrent sem revisar as APIs internas descritas em `ARCHITECTURE.md` e repetir os testes de integração.
