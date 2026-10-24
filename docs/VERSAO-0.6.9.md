# DVS Controller - versão 0.6.9

Data da preparação: 23 de outubro de 2026.

## Escopo da entrega

Fonte preparada separadamente da versão original 0.6.8. Nenhum serviço de produção foi atualizado. O instalador Windows, APK Android e IPK webOS são gerados no ambiente de build. Assinaturas dos clientes e operação nos aparelhos devem ser validadas com a instalação existente.

## Alterações

1. Dashboard para TVs redesenhado com agrupamento, indicadores do servidor e status sem repetir contadores por painel. As páginas se alternam automaticamente; conteúdo que excede a área visível é percorrido durante a rotação. O rodapé permite navegar por grupos, pausar ou entrar em tela cheia.
2. Cadastro dos dispositivos webOS, Tizen e Android inclui seleção de grupo e listas agrupadas. Quando há receiver vinculado, a alteração de grupo é propagada ao receiver. O grupo do receiver vinculado orienta a apresentação do dispositivo.
3. O servidor mantém painel, modo, grupo e zoom desejados. Heartbeats reportam observações sem substituir a atribuição. Reabertura do cliente não desfaz o grupo salvo. Playlists mantêm o painel principal atribuído enquanto reportam os itens em reprodução.
4. Login automático deixa de converter o painel direto para renderização no servidor. No modo direto, o login detecta o formulário e executa o fluxo de autenticação, inclusive JavaScript/JSON. A sessão autenticada transporta a aplicação para a TV com isolamento da administração. O usuário informa apenas link, usuário e senha; ajustes manuais ficam em opções avançadas.
5. Upload de PNG/JPEG/WebP, validação de assinatura do arquivo e exibição de imagens como painéis. Playlists de vídeos continuam restritas a vídeo; use playlists de painéis para alternar imagens e páginas.
6. Opção DVR/NVR no formulário de painel, utilizando o mecanismo RTSP/HLS existente. Endereço e credenciais RTSP permanecem cifrados e não aparecem no estado público.
7. Operador recebe acesso ao cadastro de painéis e edição de link, zoom e login. A API rejeita alteração de modo/nome de um painel existente e exclusão por operador. Cadastros de grupo, mídia, usuários e manutenção de aparelhos mantêm suas restrições.
8. A geração do WGT registra o perfil selecionado em `DVSReceiver.wgt.json`; ações de empacotar/instalar/atualizar persistem o perfil selecionado no dispositivo. O perfil temporário de contingência não substitui esse nome.
9. Documentação reconstruída: README, manual de operação, PDF, notas da versão, manual técnico e orientações de contribuição/segurança. As quatro documentações da 0.6.8 não integram a nova fonte.
10. Versão do servidor, gerenciador, instalador e clientes atualizada. Android usa `versionName 0.6.9` e `versionCode 609`. Identificadores de aplicativos permanecem iguais para permitir atualização compatível.

## Atualização controlada

1. Identifique o tipo de instalação: fonte Node.js ou instalação Electron/NSIS. Registre versão, caminho do programa, diretório de dados e backend ativo em `/api/diagnostics`.
2. Copie integralmente os dados, certificados e a chave `.secret`. Para PostgreSQL, faça backup consistente com `pg_dump` e guarde credenciais e configuração de conexão. Uma cópia de `db.json` não substitui backup do PostgreSQL ativo.
3. Ensaie com uma cópia dos dados em máquina/portas isoladas. Os testes automatizados não usam o banco de produção.
4. Pare o serviço DVS e o gerenciador antes de substituir código. O PostgreSQL deve ser tratado conforme o procedimento de backup definido pela infraestrutura; não inicialize um cluster novo sobre o existente.
5. Instalação em fonte: use o pacote de atualização e a verificação de hashes. Arquivos personalizados exigem conciliação manual; não os sobrescreva automaticamente. Instalação Electron: gere o instalador 0.6.9 e instale no mesmo destino, preservando a pasta externa de dados.
6. Instale dependências usando o lockfile. Não copie dados de laboratório sobre os existentes. Reinicie e valide leitura das credenciais antigas, atribuição de conteúdo, modo, zoom, grupos e usuários.
7. Recompile clientes IPK, WGT e APK e atualize-os em homologação com a assinatura original. Os clientes nativos carregam `/tv-app` do servidor; confirme também a recuperação após desligar/ligar a TV.
8. Remova somente as documentações antigas listadas no manifesto do pacote, depois do backup. A pasta original desta análise foi preservada.

## Reversão

Pare DVS antes de reverter. Restaure o conjunto de arquivos salvo pelo pacote de atualização ou o instalador anterior. Se a versão anterior não entender novos painéis de imagem, restaure também o backup consistente do banco, mídias e `.secret` correspondente. Não misture um banco de uma data com chave de outra instalação. Reative a versão anterior e valide uma TV de cada plataforma.

## Limites e aceite em produção

O relatório `VALIDACAO-0.6.9.md` registra os resultados efetivos. Testes de navegador não certificam firmware webOS/Tizen/Android, assinatura Samsung, políticas do site de login ou decodificação HLS em hardware. Homologar essas combinações antes de implantar. DVR/NVR nesta versão significa vídeo ao vivo via RTSP, não reprodução do arquivo histórico do gravador.

## Complemento: login e ADB

Login automático validado em aplicação real com API JSON, sem alteração do modo Direto na TV. Corrigida a exibição de Repetir vídeo em outros modos. ADB 37.0.1 incluído na distribuição e no instalador, com DLLs, licença e hashes; teste de versão real e fluxos com TV simulada executados.
