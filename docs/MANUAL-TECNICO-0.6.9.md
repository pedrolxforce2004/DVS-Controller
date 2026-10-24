# DVS Controller 0.6.9 - manual técnico

## Estrutura e responsabilidades

| Caminho | Responsabilidade |
| --- | --- |
| `server.js` | HTTP, APIs, autenticação, estado, SSE, renderização, upload e entrega de conteúdo |
| `launcher.js`, `stop.js` | Inicialização e parada da aplicação |
| `lib/config-store.js` | Configuração persistente do serviço e conexão com banco |
| `lib/postgres-store.js` | Estado PostgreSQL e projeções relacionais |
| `lib/direct-session.js` | Autenticação automática, sessões isoladas e transporte HTTP/WebSocket para o receiver |
| `lib/media-manager.js` | Processos FFmpeg, HLS, limites e expiração de streams |
| `lib/panel-health.js` | Verificação de disponibilidade dos links |
| `lib/*-manager.js` | Comandos webOS, Tizen e Android |
| `public/admin` | Administração e seleção do conteúdo das TVs |
| `public/dashboard` | Monitor de leitura, grupos, paginação e métricas |
| `public/receiver` | Motor de reprodução servido em `/tv-app` |
| `webos-client`, `tizen-client`, `android-client` | Clientes instaláveis e lançadores do receiver |
| `manager` | Aplicação Electron de gestão Windows |
| `service/host.js` | Supervisão do processo e integração com o serviço |
| `installer` | Preparação de runtime e instalação NSIS/serviços |
| `tests` | Integração, segurança, interface, upgrade e regressão 0.6.9 |

## Fluxo de execução

O cliente nativo abre o receiver hospedado no servidor. O receiver mantém identidade e token em suas configurações locais, registra-se em `/api/tv/register`, consulta seu estado e acompanha comandos por SSE e consultas de recuperação. Arquivos de reprodução podem usar o cookie de TV criado no registro. APIs de TV aceitam o token em `x-dvs-tv-token`; autenticação legada por query depende de opção explícita.

Um receiver é identificado por `tv.id`; um dispositivo de manutenção tem identidade própria e pode apontar para o receiver com `linkedTvId`. O grupo pertence ao receiver em operação e também pode existir no dispositivo antes de seu vínculo. O estado público resolve o grupo de um dispositivo vinculado pelo receiver, evitando divergência na interface.

## Modelo de dados e persistência

O estado contém `tvs`, `groups`, `panels`, dispositivos das três plataformas, `media`, `playlists`, `panelPlaylists`, `users` e `events`. O backend JSON usa `db.json` no diretório de dados; o modo PostgreSQL persiste estado e projeções pelo módulo dedicado. Não há nova migração SQL destrutiva nesta versão: os campos adicionados são propriedades do estado.

O serviço lê `service-config.json`; `DVS_DATA_DIR` determina sua localização. O host do serviço passa portas, conexão PostgreSQL, TLS e diretórios aos processos supervisionados. As credenciais do serviço e a chave `.secret` devem acompanhar o backup de dados.

A 0.6.9 mantém o formato dos modos existentes e acrescenta `image`. Não converte painéis que já estavam em `server_image` para `direct`: a intenção anterior não pode ser inferida com segurança. Um técnico deve escolher explicitamente o modo dos painéis afetados pelo comportamento antigo.

## Estado desejado e telemetria

`tv.currentPanelId`, `tv.playbackMode` e `tv.zoom` representam a configuração desejada. O comando `setPanel` recebe o modo do painel do banco. Ao editar um painel, o servidor renova o comando para TVs diretamente atribuídas e para TVs que usam uma playlist com esse painel. Isso força nova leitura de URL, zoom, credenciais ou modo, mesmo quando o ID do painel não muda.

Heartbeats guardam o item observado em `reportedPanelId`, atualizam presença/erro e reconhecem comandos. Eles não substituem painel, modo ou zoom desejados. O modo é reconciliado com o painel atribuído. Itens de uma playlist podem reportar seu ID sem transformar esse item na atribuição principal.

Registro repetido preserva nome, grupo e zoom administrativos. Vínculos automáticos por IP, quando criados, podem aplicar o grupo do dispositivo de manutenção ao novo receiver. Aparelhos com IP compartilhado devem ser vinculados manualmente para evitar associação ambígua.

## APIs principais

| API | Uso |
| --- | --- |
| `GET /api/state` | Estado de leitura usado pelo Dashboard e administração |
| `GET /api/events` | Atualizações de estado por SSE |
| `POST /api/login`, `GET /api/me` | Sessão administrativa e token CSRF |
| `POST /api/panels` | Criação ou edição; `id` informa edição |
| `PATCH /api/tvs/:id` | Nome, grupo e opções permitidas do receiver |
| `POST /api/tvs/:id/command` | Atribuição, zoom, recarga e identificação |
| `POST /api/tv/register` | Registro/retorno autenticado da identidade da TV |
| `POST /api/tv/:id/heartbeat` | Telemetria autenticada |
| `GET /api/tv/:id/state` | Somente o conteúdo associado à TV |
| `POST /api/tv/:id/direct-login` | Credenciais de formulário do painel autorizado |
| `POST /api/media/upload?name=...&title=...` | Upload binário bruto de mídia |
| `PATCH /api/{webos,tizen,android}/devices/:id` | Atualização de grupo e configuração de dispositivo |
| `GET /api/health`, `GET /api/diagnostics` | Saúde e diagnóstico |

Chamadas administrativas mutáveis usam sessão e token CSRF. Operador tem permissão de criação de painel; em edição pode alterar apenas URL, zoom e auth. Campos adicionais que divergem do painel existente são rejeitados. Conteúdo gerenciado por playlist mantém seu fluxo próprio de edição.

## Login direto e credenciais

O padrão `auth.directMethod=auto` usa somente URL, usuário e senha. O Chromium preenche o formulário detectado e executa seu fluxo real, inclusive JavaScript/JSON. Cada TV recebe uma sessão isolada; depois da autenticação, o contexto temporário do navegador é encerrado. A reprodução é a aplicação HTML/JavaScript na TV, sem captura de imagens.

`POST /api/tv/:id/direct-login` valida o token e a atribuição da TV, cria ou reutiliza a sessão e retorna somente uma URL opaca de exibição. A sessão está limitada ao painel, origem e versão das credenciais. Mudança de painel/login revoga o acesso. Sessões inativas expiram; a aplicação mantém sessões ativas por uma chamada de presença. A senha não aparece na URL de exibição, no DOM da aplicação ou no estado público.

`/direct-app/:session/*` transporta HTTP, cookies e WebSocket da origem configurada. Cookies de DVS nunca são encaminhados. Cookies do site não são instalados na origem administrativa: permanecem no servidor. O documento recebe sandbox sem `allow-same-origin`, por atributo no iframe e por CSP, impedindo acesso à página, cookies e armazenamento do DVS. CORS é limitado à origem opaca `null` nesse caminho autenticado por capacidade. O restante da API mantém suas proteções.

URLs relativas, recursos, chamadas fetch/XHR e WebSocket são adaptados ao transporte. Sites com políticas especiais, navegação por múltiplas origens, MFA ou CAPTCHA exigem validação própria. O teste da aplicação informada confirmou autenticação, dados e atualização em tempo real.

O método avançado `form_post` mantém compatibilidade com integrações manuais anteriores. Apenas esse método entrega os campos de formulário à TV autenticada. Os seletores, URL alternativa de login e nomes de campos foram retirados da área principal do cadastro.

## ADB Android empacotado

`vendor/android/platform-tools` contém `adb.exe`, as duas DLLs obrigatórias, NOTICE e versão. `vendor/android/runtime.json` fixa URL oficial, versão 37.0.1 e hashes SHA-256. `npm run prepare:adb` confere os arquivos ou baixa a distribuição oficial, valida o arquivo e extrai somente os componentes necessários.

`npm run dist:win` inclui esse runtime em `resources/android-sdk/platform-tools`. O gerenciador procura também o caminho externo ao ASAR, além de `ADB`, SDK configurado e PATH. Conexão inicia o daemon sem encerrar servidores existentes, verifica autorização e permite instalar/atualizar o APK, configurar, abrir, encerrar e remover o cliente. Nomes com espaços são protegidos ao enviar comandos ao shell Android.

Na TV, habilite a depuração pela rede e aceite a chave do computador/serviço. O empacotamento do ADB não dispensa essa autorização do aparelho. A conexão com uma TV física ainda deve ser homologada.

## Mídias e streaming

O upload aceita vídeos MP4/WebM/OGV e imagens PNG/JPEG/WebP. A assinatura inicial deve corresponder à extensão. SVG e HTML não são aceitos como imagens enviadas. O arquivo é salvo com identificador gerado pelo servidor; nomes fornecidos não determinam o caminho de armazenamento.

O modo `image` referencia `mediaId`. `loadStill` encerra a reprodução anterior, oculta iframe/vídeo e usa a imagem do receiver com `object-fit: contain`, zoom e tratamento de falhas. Playlists de painéis podem incluir imagem. Playlists de vídeos filtram apenas MIME de vídeo.

O modo `rtsp` guarda a fonte em `sourceSecret`. FFmpeg abre RTSP por TCP, transcodifica vídeo para H.264 baseline e áudio para AAC e gera HLS em segmentos de aproximadamente dois segundos e uma prévia JPEG. O gerenciador limita concorrência e encerra streams inativos. Alterar a fonte interrompe o processo anterior para que a próxima solicitação use a nova URL.

Não há player HLS por JavaScript adicional nesta entrega; compatibilidade depende do player nativo do dispositivo. O controle de histórico do gravador não é implementado.

## Métricas e Dashboard

CPU é amostrada pela diferença entre tempos das CPUs do host. RAM usa memória total/livre do sistema. Rede usa contadores Windows coletados via PowerShell/CIM e pode ficar indisponível quando a consulta falha ou em outra plataforma. A interface mostra explicitamente essa ausência.

O Dashboard pagina as linhas de painéis conforme a área disponível, mantém rotação por páginas/grupos e percorre o excesso vertical. Atualizações chegam por SSE com consulta de recuperação a cada dez segundos. Mais de trinta segundos sem receber estado aciona o aviso de dados desatualizados. O status dos painéis agrega as observações das TVs associadas e falhas conhecidas de renderização/stream.

O endpoint de estado do Dashboard é público no comportamento atual. Ele contém nomes, endereços de páginas, nomes de dispositivos e status. Não publique o serviço na Internet sem uma camada de acesso adequada para esse contexto.

## Tizen e build

O gerador tenta assinar com o perfil informado. Quando o CLI falha ao ler senhas e senhas são fornecidas, mantém a contingência temporária já existente. O perfil solicitado é mantido no cadastro e no JSON ao lado do WGT; esse JSON contém nome do perfil, versão, nome do pacote e horário, sem senhas de certificado.

O código não renomeia o perfil de TV do manifesto (`tv`), que é diferente do perfil de certificado Samsung. A assinatura e os identificadores do aplicativo precisam ser compatíveis com os aparelhos existentes. O arquivo de metadados não substitui a assinatura do WGT.

## Build, testes e implantação

Instale dependências pelo lockfile; execute `npm test`. O teste `tests/release-069.js` utiliza servidor, fixtures e dados temporários para verificar fluxo real de formulário direto, imagens, permissões, grupos, atribuições e retorno após reinício. O teste não abre uma conexão RTSP com gravador físico.

`npm run dist:win` prepara os runtimes e gera o instalador NSIS. O ambiente precisa dos recursos externos previstos em `package.json`: WinSW, Node da CLI webOS, PostgreSQL, Playwright, Android e ferramentas de build. O Android exige compilação própria, e WGT exige certificado Samsung. Não rebatize um binário da 0.6.8 como 0.6.9.

`npm run release:source` exporta uma fonte pública por lista explícita, sem dados, segredos e ferramentas de laboratório. O pacote de atualização fornece hashes, alterações separadas para conferência e o runtime ADB verificado. Não aplique uma sobreposição de arquivos em uma instalação Electron empacotada.
