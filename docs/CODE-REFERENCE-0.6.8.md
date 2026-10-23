# DVS Controller 0.6.8 - Referencia tecnica do codigo

Este documento descreve a responsabilidade dos principais arquivos da versao 0.6.8. Ele complementa o manual de producao e deve ser lido antes de alterar ou implantar o sistema.

## Estrutura

| Caminho | Responsabilidade |
| --- | --- |
| `server.js` | Servidor HTTP, API administrativa, API das TVs, SSE, autenticacao, persistencia, renderizacao remota, previews, streams, comandos e watchdogs. |
| `launcher.js` | Inicializacao local do DVS Controller fora do servico Windows. |
| `stop.js` | Encerramento local controlado. |
| `service/host.js` | Host executado pelo servico Windows/WinSW. |
| `manager/` | Aplicacao Electron de gerenciamento local. |
| `public/admin/` | Interface web administrativa. |
| `public/dashboard/` | Dashboard operacional em tela cheia. |
| `public/receiver/` | Receiver web servido para TVs e Android TV. |
| `webos-client/` | Launcher webOS empacotado como IPK; redireciona para `/tv-app`. |
| `tizen-client/` | Launcher Tizen empacotado como WGT; redireciona para `/tv-app`. |
| `android-client/` | Projeto Android TV nativo que hospeda o WebView do receiver. |
| `lib/` | Integrações com webOS, Tizen, Android, banco, midia, configuracao e saude de paineis. |
| `installer/` | Scripts do instalador Windows e configuracao PostgreSQL. |
| `scripts/` | Automacoes de manual, release de codigo-fonte e icones. |
| `tests/` | Testes de sintaxe, integracao, seguranca, upgrade e toolchains. |

## `server.js`

### Estado e persistencia

`defaultDb()` define a estrutura inicial. `normalizeDb()` garante compatibilidade ao abrir bancos antigos e cria colecoes ausentes como `panelPlaylists`. `loadDb()`, `saveDb()` e a fila de escrita protegem o JSON local; quando configurado, `PostgresStore` persiste no PostgreSQL.

### Estado publico

`publicState()` devolve apenas campos seguros para a administracao. `publicPanel()` remove segredos (`authSecret`, `sourceSecret`) e mascara usuario de login automatico. A rota de TV (`/api/tv/:id/state`) envia somente o painel atribuido, suas playlists necessarias e midias relacionadas.

### Renderizacao no servidor

`maybeCapturePanel()` controla captura por painel e evita trabalho duplicado. `capturePanelWithDeadline()` reinicia Chromium quando a captura excede `RENDER_TIMEOUT_MS`. `capturePanel()` reutiliza paginas Playwright por painel, aplica login automatico, zoom e salva JPG.

Previews administrativos usam `handlePanelPreview()`, com cache `PREVIEW_CACHE_MS`, fila global e limite por IP para evitar centenas de downloads simultaneos. TVs usam `handlePanelMjpeg()`, com limites `MAX_MJPEG_STREAMS` e `MAX_MJPEG_PER_IP`.

### Playlists

`/api/playlists` gerencia playlists de videos. `/api/panel-playlists` gerencia playlists de paineis, com `panelId` e `durationSeconds` por item. `ensurePlaylistPlaybackPanel()` cria ou reutiliza o painel tecnico que o receiver ja entende; `assignPanelToTv()` permite salvar e enviar a playlist em uma unica operacao. O campo `panelId` preserva essa associacao nas edicoes e os dados antigos sao reconhecidos pela referencia existente. O backend bloqueia playlist de paineis dentro de playlist de paineis para evitar ciclo.

### Comandos de TV

`/api/tvs/:id/command` aceita `setPanel`, `setZoom`, `reload` e `identify`. Cada comando recebe ID, fica pendente no banco e tambem e entregue por SSE quando a TV esta conectada.

## `public/admin/app.js`

A administracao carrega `/api/state` e mantem assinaturas independentes para Dashboard, recursos, webOS, Tizen e Android. Eventos de telemetria alteram apenas texto e indicadores dos cards, sem substituir os elementos de formulario em uso. O Dashboard administrativo contem somente operacao das TVs. A aba `Painel e Midia` usa navegacao interna para separar paineis, grupos, midias e playlists sem duplicar cadastros.

Principais funcoes:

| Funcao | Papel |
| --- | --- |
| `renderGroups()` | Lista grupos e atualiza filtro das TVs. |
| `renderPanels()` | Lista paineis, mostra modo, zoom e erro de renderizacao. |
| `previewFor()` | Monta preview preguiçoso com `IntersectionObserver`. |
| `enqueuePreview()` / `runPreviewQueue()` | Limitam previews a duas requisicoes, carregam apenas cards visiveis e trocam o quadro somente depois do download completo. |
| `stopPreviewWork()` | Cancela fila e downloads quando a aba ou a janela ficam ocultas. |
| `renderMedia()` | Lista videos e prepara os editores de playlists. |
| `editVideoPlaylist()` / `editPanelPlaylist()` | Edita playlists mantendo o painel tecnico associado. |
| `updateTargetTvSelects()` | Preenche a opcao de envio imediato para uma TV. |
| `openRemote()` | Abre sessao interativa de painel renderizado com preview prioritario e troca atomica de quadros. |
| `remoteAction()` | Enfileira clique, texto, teclado, scroll e reload contra `/api/panels/:id/interact`. |
| `runTizenAction()` | Executa conectar, gerar WGT, instalar e iniciar Tizen. |
| `runAndroidAction()` | Executa conectar, instalar, configurar e iniciar Android TV. |

Na versao 0.6.8, `VideoWall legado` e `Camera / stream RTSP` foram removidos do formulario de novo painel. O codigo ainda mostra nomes desses modos para registros antigos.

`lib/tizen-manager.js` usa `connectWithRetry()` para iniciar o daemon SDB, aguardar a porta local 26099, repetir a conexao com a TV e confirmar estado `device`. Isso evita a falha transitoria observada quando `sdb connect` precisava iniciar o daemon e tentava o handshake imediatamente.

## `public/receiver/receiver.js`

Este arquivo roda dentro do navegador das TVs e do Android WebView.

Fluxo:

1. Lê configuracao local ou parametros de `/tv-app`.
2. Registra/atualiza a TV no servidor.
3. Mantem heartbeat.
4. Consulta comandos por SSE/poll.
5. Executa o modo solicitado.

Modos:

| Modo | Funcao |
| --- | --- |
| `direct` | `loadDirect()` abre iframe. |
| `server_image` | `loadServerImage()` abre MJPEG renderizado. |
| `video` | `loadVideo()` reproduz uma midia. |
| `playlist` | `loadPlaylist()` reproduz videos em sequencia. |
| `panel_playlist` | `loadPanelPlaylist()` alterna paineis com tempo por item. |
| `legacy_videowall` / `rtsp` | Mantidos para compatibilidade com dados antigos. |

Zoom da TV e zoom do painel sao combinados por `effectiveZoom()`.

## `lib/tizen-manager.js`

Integra o Tizen Studio.

Pontos principais:

| Funcao | Papel |
| --- | --- |
| `cliStatus()` | Localiza SDB/Tizen CLI. |
| `certificateProfiles()` | Lista perfis do Certificate Manager. |
| `packageClient()` | Gera WGT com `build-web` e `package -t wgt`. |
| `packageWithSigningProfile()` | Assina usando o perfil original; temporario so em fallback. |
| `install()` | Envia WGT por SDB e instala com `vd_appinstall`. |
| `launch()` / `close()` | Inicia ou encerra o receiver na TV. |

Para o perfil `INFRA`, a chamada principal usa `-s INFRA`. O nome temporario `DVS_INFRA_*` nao e usado no caminho normal.

## `lib/webos-manager.js`

Empacota `webos-client` via `ares-package`, instala via `ares-install`, pareia SSH com Key Server e renova Developer Mode quando disponivel.

## `lib/android-manager.js`

Localiza ADB, conecta na Android TV, instala APK, envia configuracao por broadcast e abre o app. A porta padrao e `5555`.

## `android-client/app/src/main/java/br/com/decode/dvsreceiver/MainActivity.java`

Aplicacao Android TV nativa. Mostra tela de configuracao, valida URL do servidor e abre `/tv-app` em WebView. A 0.6.8 adiciona watchdog: se o WebView fica parado ou em erro por minutos, ele recarrega automaticamente.

## Build e artefatos

| Artefato | Origem |
| --- | --- |
| `com.decode.dvscontroller_0.6.8_all.ipk` | `lib/webos-manager.packageClient()` sobre `webos-client/`. |
| `DVS-Receiver-webOS-0.6.8.ipk` | Copia versionada do IPK webOS para `dist/`. |
| `DVSReceiver.wgt` | `lib/tizen-manager.packageClient()` sobre `tizen-client/`. |
| `DVS-Receiver-0.6.8.apk` | `android-client` com Gradle. |
| `DVS-Controller-Setup-0.6.8.exe` | `npm run dist:win`. |
| `DVS-Controller-0.6.8-Manual.pdf` | `scripts/generate-manual.py`. |
| `SHA256SUMS-0.6.8.txt` | Hashes dos artefatos finais. |

## Cuidados

- Nunca publique `data/`, `.secret`, certificados, keystores ou backups.
- Nao altere `appId`/`applicationId` dos clients sem planejar migracao dos aparelhos.
- Antes de producao, valide pelo menos uma TV LG webOS, uma Samsung Tizen e uma Android TV fisica.
- Para instalador Windows, gere os receivers antes, pois `package.json` inclui IPK e APK dentro do instalador.
