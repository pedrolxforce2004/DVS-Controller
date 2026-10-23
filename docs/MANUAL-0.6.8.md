# DVS Controller

## Manual de producao - versao 0.6.8

Edicao: 30 de setembro de 2026. Publico: infraestrutura, implantacao e operacao.

## 1. Visao geral

O DVS Controller centraliza paineis, grupos, TVs LG webOS, Samsung Tizen e Android TV. A versao 0.6.8 e uma atualizacao direta da 0.6.7 e preserva banco, usuarios, TVs, grupos, paineis, tokens e segredos criptografados.

| Modo | Funcionamento |
| --- | --- |
| Direto na TV | A TV abre o link no proprio navegador. |
| Renderizar no servidor | Chromium no servidor captura a pagina e envia imagem para as TVs. |
| Video individual | Reproduz um video cadastrado. |
| Lista de videos | Reproduz videos cadastrados em sequencia. |
| Playlist de paineis | Alterna links/paineis cadastrados com tempo individual por item. |

Os modos VideoWall legado e Camera/stream RTSP deixam de aparecer para novos cadastros na administracao. Paineis antigos nesses modos continuam legiveis para compatibilidade durante a migracao.

## 2. Novidades da 0.6.8

- Geracao WGT Tizen preserva o nome do perfil informado, como `INFRA`. Perfil temporario so e usado como fallback quando o Tizen Studio falha ao ler a senha salva.
- Conexao Tizen inicia o servidor SDB explicitamente, aguarda a estabilizacao e repete o handshake ate tres vezes antes de informar falha.
- Previews de paineis renderizados foram limitados por IP, enfileirados e cacheados para reduzir excesso de requisicoes e tela preta.
- Sessao interativa de paineis renderizados recebe prioridade, reaproveita o ultimo quadro enquanto atualiza e troca a imagem sem tela branca apos comandos.
- Grupos ganharam area com rolagem.
- Novo modo Playlist de paineis com tempo em segundos por painel.
- Dashboard reorganizado com cards mais compactos e melhor leitura de quantidade/status.
- Cliente Android TV 0.6.8 ganhou watchdog de WebView para recarregar automaticamente quando a exibicao fica travada.
- Dashboard administrativo dedicado ao monitoramento e envio de conteudo para as TVs.
- Previews do Dashboard usam fila com duas requisicoes simultaneas, atualizam somente itens visiveis a cada 15 segundos e sao cancelados ao sair da aba.
- Eventos de telemetria atualizam status e horarios sem reconstruir cards, mantendo seletores e controles abertos durante a operacao.
- Aba `Painel e Midia` centraliza paineis, grupos, biblioteca de videos e playlists em quatro secoes.
- Playlists criam ou reutilizam automaticamente o painel tecnico de reproducao e podem ser enviadas a uma TV no mesmo formulario.

## 3. Atualizacao em producao

1. Agende janela de manutencao.
2. Faca backup de `%ProgramData%\DVS Controller`, incluindo `db.json`, `.secret`, `service-config.json` e backups do PostgreSQL se aplicavel.
3. Confirme que a versao em execucao e 0.6.7.
4. Instale a 0.6.8 no mesmo diretorio usado pela 0.6.7.
5. Valide login administrativo, dashboard, TVs online, renderizacao no servidor e envio de comandos.
6. Gere novamente WGT Tizen e APK Android TV quando for atualizar os receivers dos aparelhos.

O instalador cria copia preventiva em `backups/upgrade-0.6.8-*`. Nao remova `.secret`; sem ele nao e possivel descriptografar credenciais de paineis.

## 4. Painel e Midia

Na administracao, abra `Painel e Midia`. As secoes internas separam Paineis, Grupos, Midias e Playlists. O Dashboard nao contem cadastros: ele fica reservado para acompanhar TVs, ajustar zoom e escolher o conteudo exibido.

Para criar uma playlist de videos, envie os arquivos em Midias, abra Playlists, selecione os videos e salve. Para uma playlist de paineis, selecione os paineis e informe o tempo de exibicao em segundos. Em ambos os casos, `Exibir agora` permite escolher uma TV; deixe `Somente disponibilizar` para apenas incluir a playlist no seletor do Dashboard.

Nao e necessario cadastrar uma reproducao ou criar outro Painel WEB. O servidor cria ou reutiliza automaticamente o painel tecnico associado. Ao editar a playlist, a mesma associacao e mantida para evitar duplicidade.

Cada item pode apontar para painel direto, renderizado no servidor, video ou lista de videos. Evite inserir paineis muito pesados com tempos curtos; para renderizacao no servidor, use 15 segundos ou mais como ponto inicial.

## 5. Renderizacao no servidor

O servidor mantem paginas Chromium por painel renderizado. A rota de preview usa cache curto e fila para evitar rajadas vindas da administracao. O cliente limita a concorrencia, observa a visibilidade dos cards e interrompe requisicoes quando o Dashboard fica oculto. A sessao interativa pode receber imediatamente o ultimo quadro valido e atualiza a captura em segundo plano. TVs usam fluxo MJPEG com limite de conexoes por IP.

Variaveis uteis:

| Variavel | Padrao | Uso |
| --- | --- | --- |
| `RENDER_FPS` | 1 | Quadros por segundo dos paineis renderizados. |
| `RENDER_TIMEOUT_MS` | 30000 | Tempo maximo antes de reiniciar Chromium travado. |
| `RENDER_IDLE_MS` | 30000 | Janela para liberar paginas sem uso. |
| `PREVIEW_CACHE_MS` | 15000 | Cache dos previews da administracao. |
| `MAX_MJPEG_STREAMS` | 64 | Limite global de fluxos renderizados. |
| `MAX_MJPEG_PER_IP` | 4 | Limite de fluxos por IP. |

Se um painel ficar preto, teste a URL no navegador do servidor, verifique login automatico, consumo de CPU/memoria e erros de renderizacao mostrados na lista de paineis.

## 6. Tizen

Cadastre o perfil exatamente como aparece no Certificate Manager, por exemplo `INFRA`. A 0.6.8 chama o empacotamento com esse nome. Se o CLI do Tizen nao conseguir usar a senha salva, o DVS cria um perfil temporario apenas para concluir a assinatura e remove esse perfil ao final.

Fluxo recomendado:

1. Validar SDK em Dispositivos Tizen.
2. Consultar perfis.
3. Salvar o perfil no dispositivo.
4. Gerar WGT.
5. Instalar/atualizar e iniciar o receiver.

Se a porta `26101` responder, mas a primeira conexao mostrar `Server is not running`, use novamente a acao Conectar. A revisao final da 0.6.8 faz essa recuperacao automaticamente e confirma o aparelho em `sdb devices` antes de considerar a conexao concluida.

## 7. Android TV

O APK 0.6.8 envia `launcherVersion=0.6.8` e monitora o WebView. Se a tela ficar parada por cerca de tres minutos, o app avalia o conteudo e recarrega automaticamente quando detectar erro/tela sem conteudo.

Para atualizar:

1. Compile ou obtenha `DVS-Receiver-0.6.8.apk`.
2. Instale com `adb install -r DVS-Receiver-0.6.8.apk`.
3. Confirme que a TV aparece online e que o painel continua rodando apos reiniciar a TV.

## 8. Codigo principal

| Arquivo | Responsabilidade |
| --- | --- |
| `server.js` | API, estado, renderizacao no servidor, previews, playlists e comandos das TVs. |
| `public/admin/app.js` | Administracao web, cadastro de paineis, grupos, devices e sessao interativa. |
| `public/receiver/receiver.js` | Receiver web executado pelas TVs e Android TV. |
| `lib/tizen-manager.js` | SDK Tizen, assinatura WGT, instalacao e inicializacao Samsung. |
| `android-client/.../MainActivity.java` | Launcher Android TV e watchdog do WebView. |
| `public/dashboard/*` | Dashboard operacional com rotacao e metricas. |

A referencia tecnica completa dos arquivos esta em `docs/CODE-REFERENCE-0.6.8.md`.

## 9. Verificacao

Antes de liberar em producao, execute:

```powershell
npm run test:syntax
npm run test:admin-ui
npm run test:dashboard-ui
npm run test:receiver-ui
```

Quando possivel, valide fisicamente uma TV de cada plataforma. A homologacao fisica e essencial porque firmware, WebView, codecs e certificados variam por modelo.
