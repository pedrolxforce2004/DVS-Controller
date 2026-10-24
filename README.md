# DVS Controller 0.6.9

Controle centralizado de conteúdo para TVs LG webOS, Samsung Tizen e Android TV. Inclui servidor Node.js, administração web, Dashboard para TVs e gerenciador Windows.

## Nesta versão

- Dashboard por grupos, com status dos painéis, CPU, RAM e tráfego de rede do servidor; paginação, rotação e indicação de dados desatualizados.
- Dispositivos das três plataformas organizados pelos mesmos grupos dos receivers.
- Modo de exibição definido pelo servidor, protegido contra heartbeats antigos e mudanças involuntárias ao habilitar login.
- Login direto automático para formulários tradicionais e JavaScript/JSON, com cadastro simplificado de usuário e senha.
- Imagens PNG, JPEG e WebP como painéis, inclusive em playlists de painéis.
- Cadastro de DVR/NVR via RTSP, convertido para HLS pelo FFmpeg.
- Operadores podem cadastrar painéis e editar link, zoom e credenciais. Exclusão e configuração dos dispositivos permanecem restritas.
- ADB Android 37.0.1 empacotado com DLLs e verificação SHA-256, sem exigir instalação separada do SDK.
- Perfil Samsung selecionado preservado no cadastro e no metadado do WGT.

## Documentação

- [Manual de operação em PDF](docs/DVS-Controller-0.6.9-Manual.pdf)
- [Manual de operação em Markdown](docs/MANUAL-0.6.9.md)
- [Manual técnico](docs/MANUAL-TECNICO-0.6.9.md)
- [Notas e atualização da versão](docs/VERSAO-0.6.9.md)
- [Validação e limites da entrega](docs/VALIDACAO-0.6.9.md)
- [Segurança](SECURITY.md) e [contribuição](CONTRIBUTING.md)

## Executar com dados isolados

Requer Node.js 22 ou superior. Na pasta do código:

```powershell
npm ci
$env:DVS_DATA_DIR = 'C:\DVS-Laboratorio\data'
$env:DVS_ENABLE_ADMIN_AUTH = '1'
npm run dev
```

Abra `http://localhost:3080/admin`. Em uma base nova, entre com `admin` / `admin` e altere a senha no primeiro acesso. O arquivo `.env.example` é uma referência: o servidor não o carrega automaticamente. Instale o navegador do Playwright para renderização: `npx playwright install chromium`.

`/admin` gerencia TVs e conteúdo. `/dashboard` é uma visão pública de leitura para exibição em TVs. `/tv-app` executa o receiver web. Proteja o acesso ao Dashboard na rede quando nomes e status forem informação interna.

## Atualizar uma instalação

A fonte e o instalador Windows 0.6.9 são entregues separadamente. O instalador inclui ADB, APK Android e IPK webOS recompilados. O WGT Samsung exige o perfil de assinatura da organização. Não substitua `app.asar` por uma pasta de fontes. Para uma instalação Electron, gere o instalador 0.6.9 a partir desta fonte e preserve o diretório de dados. Consulte as notas da versão antes de aplicar o pacote.

Preserve `service-config.json`, `db.json`, `.secret`, mídias, banco PostgreSQL e certificados. A chave `.secret` permite ler as credenciais já salvas; trocar essa chave torna essas credenciais ilegíveis. Ensaie atualização e reversão com cópias dos dados antes da janela de manutenção.

## Testes e distribuição

```powershell
npm test
npm run test:release
npm run dist:win
npm run release:source
```

Algumas verificações exigem CLI webOS, Tizen Studio, ADB, PostgreSQL e navegadores locais. O relatório da entrega distingue testes executados de dependências ausentes. A compilação Android exige JDK 17, Gradle compatível com o projeto e SDK 35. Use a mesma chave de assinatura dos clientes existentes para permitir atualização dos aplicativos.

## Compatibilidade de conteúdo

Login direto usa o link do painel, usuário e senha, com detecção automática do formulário. O servidor prepara a sessão com Chromium e transporta a aplicação autenticada em um iframe isolado; os scripts e a renderização continuam na TV. Seletores e método POST manual ficam em opções avançadas. MFA, CAPTCHA e redirecionamento para provedores de outra origem exigem integração específica.

DVR/NVR exige URL RTSP documentada pelo fabricante, credenciais e conectividade do servidor. HLS nativo depende do modelo/firmware da TV. Reprodução de gravações, seleção de canais e controle PTZ não são implementados; um canal RTSP é cadastrado como um painel. WebP também depende do firmware; prefira PNG/JPEG em TVs antigas.
