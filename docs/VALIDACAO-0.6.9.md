# Validação da atualização 0.6.9

Preparada em 23 de outubro de 2026, sobre a fonte 0.6.8 fornecida. O projeto não possui metadados Git nesta pasta. A comparação usa hashes SHA-256 da base original.

## Resultado

A suíte `npm test` concluiu com código de saída 0 no ambiente Windows, com dados temporários. O teste ADB Android executou o binário empacotado 37.0.1 e confirmou Android Debug Bridge 1.0.41, sem depender de ADB instalado no PATH. Esse resultado não equivale a homologação de instalação em TVs físicas.

Foram executados:

| Verificação | Resultado |
| --- | --- |
| Sintaxe JavaScript e caminhos da instalação do serviço | Aprovado |
| CLI webOS 3.2.5 e geração de IPK em laboratório | Aprovado; pacote temporário de teste |
| CLI Tizen/SDB | Aprovado; não assina um WGT de produção |
| ADB Android empacotado | Aprovado: versão real, DLLs e SHA-256 |
| Configuração, integração HTTP e segurança | Aprovado |
| PostgreSQL em cluster temporário | Aprovado |
| Watchdog e substituição do processo | Aprovado |
| Interfaces do gerenciador, administração, Dashboard e receiver | Aprovado |
| Saúde dos links: HTTP, redirecionamento, timeout, cache e concorrência | Aprovado |
| Atualização preservando configuração, identidades, banco e chave | Aprovado em fixture |
| Login direto JavaScript/JSON, API, WebSocket e isolamento | Aprovado em fixture e na aplicação real informada |
| Método POST manual dentro do iframe | Aprovado com servidor de teste local |
| Escopo das credenciais por TV e ausência de segredo no estado público | Aprovado |
| Permissões de operador: link/zoom/login e rejeição de ações restritas | Aprovado |
| Upload de imagem, rejeição de assinatura inválida e exibição no receiver | Aprovado |
| Cadastro RTSP com endereço cifrado | Aprovado |
| FFmpeg real: produção HLS/segmentos, falha RTSP, limpeza e ocultação de credenciais | Aprovado |
| Preservação da playlist e modo diante de heartbeat atrasado | Aprovado |
| Grupos dos dispositivos webOS, Tizen e Android e persistência após reinício | Aprovado |
| Dashboard em 1280x720, 1920x1080 e 3840x2160 | Aprovado em navegador; capturas incluídas |
| Perfil Tizen no resultado/metadado e contingência temporária | Aprovado com CLI simulada, sem assinatura real |
| Atualizador: conferência, rejeição de personalização, backup, aplicação e reversão | Aprovado em cópia temporária |
| Manual PDF | Sete páginas A4, renderizadas e revisadas visualmente |

Após ajustes finais pontuais, foram repetidos os testes diretamente afetados. O teste adicional de perfil Tizen também foi incorporado à suíte.

## Condições do laboratório

Dependências de aplicação instaladas na cópia isolada usando o lockfile; Chromium local para os testes de navegador; FFmpeg instalado na cópia; CLI webOS 3.2.5 preparada somente para teste. A integração PostgreSQL usou os binários existentes em modo de leitura para criar um cluster novo em diretório temporário. A opção `DVS_TEST_PG_BIN` permite informar esse caminho no teste.

Nenhum teste foi apontado para `data` original ou banco de produção. A aplicação/reversão do pacote foi executada somente em uma instalação fictícia criada no diretório temporário do sistema.

## O que ainda depende da implantação

- O instalador EXE e os clientes APK/IPK da 0.6.9 foram gerados. WGT continua dependente do certificado Samsung. O APK produzido usa assinatura local diferente da 0.6.8; atualização dos APKs existentes depende dos dados da chave original.
- Validar instalação e reinício físico em webOS, Tizen e Android TV.
- Login validado na aplicação real indicada pelo usuário, incluindo Dashboard autenticado, dados da API e WebSocket. MFA/CAPTCHA/OAuth externo ainda exigem integração própria.
- Validar um canal ao vivo do DVR/NVR real, largura de banda, CPU e decodificação HLS nos firmwares usados. Não foi conectado um gravador físico nem implementado acesso ao histórico.
- Ensaiar o instalador e a restauração com cópias consistentes do banco/mídias de produção, antes da janela de manutenção.

## Integridade e revisão

`original-sha256.json` registra os 90 arquivos originais de código/documentação acompanhados; sua preservação foi conferida na geração do pacote. `UPDATE-MANIFEST.json` descreve as diferenças da entrega. `source/SOURCE-SHA256SUMS.txt` cobre os arquivos da fonte exportada. `SHA256SUMS.txt`, ao lado do ZIP, permite conferir o arquivo de distribuição.

As quatro documentações da 0.6.8 são removidas apenas quando a atualização é aplicada ao destino autorizado, após seu backup. Elas continuam presentes na pasta original analisada.

## Complemento de build e execução empacotada
+
+- `npm run dist:win` gera o instalador Windows x64 NSIS, sem executar a instalação ou alterar serviços de produção.
+- APK recompilado com Gradle 8.11.1, JDK 17 e SDK 35; chave local não coincide com a assinatura do APK 0.6.8 fornecido. Os dados da chave anterior foram solicitados para permitir atualização sem desinstalação.
+- IPK webOS 0.6.9 recompilado para distribuição.
+- Runtime ADB 37.0.1 baixado da distribuição oficial Google e conferido por SHA-256; binário, duas DLLs, licença e versão incluídos.
+- Payload ASAR comparado com a fonte; serviço executado via runtime Electron sem instalar serviços, ADB real localizado fora do ASAR e APK encontrado no diretório de recursos.
+- Login da aplicação real também testado pelo servidor empacotado com Chromium incluído. Página autenticada, API, WebSocket e isolamento aprovados; nenhuma alteração de câmera/configuração foi realizada.
+- Fluxo ADB com TV simulada: iniciar daemon, conectar, autorização, instalação com `-r`, configuração com nomes compostos, abrir e encerrar aprovados. TV Android física não foi utilizada.
+- Ajustadas localização de recursos fora do ASAR e execução do FFmpeg desempacotado no serviço Windows.
+
A preparação do ADB também foi testada do zero: download, extração, hashes e reutilização do runtime conferidos em pasta temporária. O instalador EXE não possui assinatura digital de editor.
