# DVS Controller

Manual de operação - versão 0.6.9

23 de outubro de 2026 | Decode

## 1. Conheça o ambiente

O DVS Controller distribui páginas web, painéis renderizados, vídeos, imagens e canais RTSP para TVs LG webOS, Samsung Tizen e Android TV. Cada TV recebe um painel ou uma playlist. Os grupos organizam os receivers e os dispositivos usados para instalar e manter os aplicativos.

O servidor central mantém a configuração desejada. O receiver busca conteúdo, envia sinal de presença e recebe comandos. O gerenciador Windows acompanha o serviço. Banco de dados, credenciais e arquivos enviados ficam no diretório de dados da instalação, separado do código.

Use a administração em `/admin` para operar. Use `/dashboard` para acompanhar o ambiente em uma TV. Use `/tv-app` para iniciar o receiver em um navegador compatível ou pelo aplicativo nativo.

Em uma base nova, o usuário inicial é `admin`, com senha `admin` e troca obrigatória. Uma instalação existente conserva seus usuários. Ative a autenticação administrativa e configure HTTPS antes de usar credenciais pela rede.

## 2. Instalação e atualização

A entrega inclui código-fonte e instalador Windows 0.6.9, gerado com `npm run dist:win`. Execute o instalador somente após o backup e a homologação. A preparação não instalou nem alterou serviços de produção; a pasta de fontes não substitui o arquivo `app.asar`.

Antes de atualizar, registre os caminhos do programa e dos dados. Em instalações Windows, os dados normalmente ficam em `%ProgramData%\DVS Controller`; o ambiente pode definir outro caminho por `DVS_DATA_DIR`. Faça backup completo, incluindo `.secret`, `service-config.json`, mídias e banco. Se o backend for PostgreSQL, faça backup consistente do banco ativo.

Pare o serviço DVS e o gerenciador durante a troca. Mantenha as portas, os certificados, o banco existente e as identidades dos clientes. Faça o primeiro ensaio em uma cópia dos dados e valide uma TV de cada plataforma antes da implantação geral.

Para uma instalação de laboratório em fonte, use Node.js 22+, execute `npm ci`, defina uma pasta exclusiva em `DVS_DATA_DIR`, habilite `DVS_ENABLE_ADMIN_AUTH=1` e execute `npm run dev`. A porta padrão é 3080. O arquivo `.env.example` não é carregado automaticamente.

## 3. Usuários e permissões

Supervisor administra usuários e todas as operações. Técnico cuida de conteúdo, grupos e aparelhos, sem administrar usuários. Operador pode cadastrar painéis, editar link, zoom e credenciais dos painéis e enviar comandos permitidos às TVs.

O operador não pode excluir painéis nem alterar seu modo ou nome após o cadastro. Instalação de aplicativos, arquivos de mídia, grupos e gestão de usuários continuam reservados aos perfis de manutenção. As restrições são verificadas no servidor, mesmo que alguém tente chamar a API diretamente.

Ao cadastrar um usuário, escolha senha forte e a necessidade de troca no primeiro acesso. Não compartilhe a conta de supervisor para a operação diária. Sessões expiram conforme os limites configurados pelo administrador.

## 4. Grupos e cadastro das TVs

Em Painel e Mídia, abra Grupos e cadastre nomes como Recepção, Operações ou Produção. O grupo Principal é o destino padrão. No Dashboard administrativo, vincule os receivers aos grupos e selecione o conteúdo de cada TV.

Em webOS, Tizen e Android, o formulário do dispositivo também possui o grupo. As listas dessas áreas são apresentadas por grupo. É possível mudar o grupo no próprio cartão. Quando o dispositivo possui um receiver vinculado, essa alteração atualiza o grupo do receiver. O grupo do receiver vinculado é usado para a apresentação.

Um dispositivo representa a conexão de manutenção; o receiver representa o aplicativo que reproduz conteúdo e envia presença. Vincule ambos para que instalação, status e grupo representem o mesmo aparelho. Ao registrar um receiver pela primeira vez, o servidor pode vinculá-lo por IP ao dispositivo conhecido.

Ao excluir um grupo, os receivers e dispositivos associados retornam ao grupo Principal. Revisões posteriores do cadastro do cliente não devem desfazer o grupo já escolhido na administração.

## 5. Painéis web e modo de exibição

Em Painel e Mídia, abra Painéis. Informe nome, endereço, modo de exibição e zoom. Salve e selecione esse painel no cartão da TV na administração.

Direto na TV carrega o endereço no navegador da TV. Escolha esse modo para aplicações que funcionam no navegador do aparelho e permitem exibição em iframe. Recursos e compatibilidade dependem do firmware e do site.

Renderizar no servidor abre a aplicação em um navegador no servidor e envia imagens ao receiver. É útil para páginas mais pesadas e login por seletores CSS. Exige Playwright/Chromium disponível e capacidade de CPU/RAM no servidor. VideoWall legado continua disponível para instalações que já utilizam essa forma de apresentação.

O modo salvo no painel prevalece. Habilitar login não muda mais o modo automaticamente. Selecione a mudança de modo explicitamente com um perfil autorizado. Heartbeats da TV não substituem a atribuição desejada; isso também protege playlists contra relatos de um item interno.

## 6. Login automático

No cadastro do painel, mantenha o link e o modo Direto na TV. Abra Login automático, marque Este painel exige login e informe somente usuário e senha. O sistema identifica os campos e o botão de entrada, incluindo formulários que usam JavaScript e enviam JSON. Não é preciso repetir o endereço nem informar os nomes dos campos.

O servidor prepara a sessão autenticada uma vez e transporta a aplicação com seus cookies para o receiver. A página, seus scripts e sua apresentação continuam sendo executados na TV; o modo não é convertido para imagens do servidor. A aplicação fica isolada da administração DVS e não recebe os cookies ou tokens administrativos. O Chromium do servidor é necessário para preparar o login.

Se o site tiver campos incomuns, abra Opções avançadas e informe os seletores. Página de login diferente é opcional e deve ficar na mesma origem do painel. Formulário POST manual continua disponível para integrações específicas; apenas nessa opção são exibidos os nomes dos campos.

Ao editar, deixe a senha vazia para conservar a já salva. O usuário aparece mascarado nas listagens e os segredos permanecem cifrados. MFA, CAPTCHA e provedores externos podem exigir integração própria. O fluxo automático foi validado com uma aplicação JavaScript/JSON, APIs e WebSocket, sem mudar para renderização de imagens.

## 7. Imagens e vídeos

Em Mídias, envie PNG, JPEG, WebP, MP4, WebM ou OGV. O servidor verifica a assinatura do arquivo além de sua extensão. Prefira PNG/JPEG em TVs antigas e MP4 H.264 para ampla compatibilidade de vídeo. O limite de upload é configurável no servidor.

Para uma imagem, crie um painel no modo Imagem e selecione o arquivo da biblioteca. A exibição preserva a proporção, com ajuste de zoom. Para vídeo individual, selecione o modo correspondente, o arquivo e a opção de repetição.

Para alternar imagens, páginas e vídeos, use uma playlist de painéis e defina a duração de cada item. A playlist de vídeos aceita apenas vídeos. Ao excluir uma mídia utilizada, os painéis dependentes precisam receber outra mídia; verifique os vínculos antes da remoção.

## 8. DVR e NVR

Crie um painel e selecione DVR / NVR (RTSP). Informe a URL completa do canal, incluindo usuário e senha quando exigidos, de acordo com a documentação do fabricante. Um exemplo ilustrativo é `rtsp://usuario:senha@gravador:554/canal`; o caminho real varia entre equipamentos.

O servidor precisa alcançar o gravador. O FFmpeg converte o canal para HLS, que a TV reproduz. O endereço RTSP fica cifrado e não aparece nas listagens públicas. Ao editar, deixe o endereço vazio para conservar a fonte salva ou informe outro canal.

Cadastre um painel por canal. O número de conversões simultâneas é limitado para proteger o servidor. O padrão é oito streams; capacidade real depende da resolução e do processador. HLS adiciona atraso e sua reprodução nativa varia por TV.

O suporte é para canais ao vivo disponibilizados por RTSP. Busca de gravações, reprodução de histórico, PTZ, descoberta ONVIF e protocolos proprietários do fabricante não fazem parte desta versão. Valide o canal e o firmware usados pela organização.

## 9. Aplicativos webOS, Tizen e Android

LG webOS: ative o Developer Mode e o Key Server na TV, cadastre IP, porta e passphrase e faça o pareamento. Instale o IPK gerado com os mesmos identificadores do aplicativo existente. As opções de renovação e abertura automática dependem do acesso de manutenção e das condições do modo de desenvolvimento.

Samsung Tizen: configure Tizen Studio, ative o modo de desenvolvimento da TV e permita o IP do computador. Cadastre o perfil de certificado Samsung usado pela organização. Empacotar gera o WGT e o arquivo de metadados com o nome desse perfil. A contingência de assinatura pode usar perfil temporário sem substituir o nome selecionado no cadastro.

Android TV: o ADB 37.0.1 e suas DLLs acompanham o pacote Windows. Habilite depuração e acesso ADB pela rede, aceite a autorização na TV e cadastre o IP e a porta (padrão 5555). Não é necessário instalar o Android Studio no servidor DVS. Compile o APK com SDK 35, versão 0.6.9 e código 609. Para atualizar um aplicativo instalado, use a mesma chave de assinatura. O cliente possui mecanismos de recuperação do WebView; confirme o retorno após reinício físico.

O instalador Windows é gerado com `npm run dist:win`, incluindo ADB, APK Android e IPK webOS. A atualização de APK já instalado exige a mesma chave de assinatura; verifique a compatibilidade antes de atualizar os aparelhos. O WGT Samsung depende do perfil de certificado da organização. Certificados e chaves de assinatura não devem ser publicados junto da fonte. O procedimento de instalação deve ser homologado com o hardware real.

## 10. Dashboard e operação diária

Abra `/dashboard` na TV de monitoramento. A faixa superior mostra totais do ambiente e uso do servidor. CPU e RAM representam o host; a memória inclui o sistema e outros processos. Rede mostra tráfego agregado em Mb/s, com recebimento e envio. Se não houver coleta, aparece Indisponível, sem simular zero.

Os painéis aparecem dentro dos grupos. Cada cartão mostra nome, estado, TVs vinculadas e modo. Um cartão pode sinalizar falha quando uma TV não responde recentemente, reporta erro ou o mecanismo de renderização/stream apresenta erro. ONLINE indica presença reportada; não certifica visualmente a página final dentro de um iframe.

Use o rodapé para selecionar grupos, os botões anterior/próximo para percorrer páginas e Pausar para ler uma tela. Em ambientes maiores, a rotação percorre páginas; conteúdo vertical excedente é percorrido automaticamente durante a rotação. O parâmetro `?interval=30` define trinta segundos por página, dentro dos limites de cinco a trezentos segundos.

Dados desatualizados indica ausência de atualização recente. A interface preserva a última amostra e tenta carregar novamente. O relógio segue o fuso do navegador em que o Dashboard está aberto.

## 11. Diagnóstico, backup e reversão

TV offline: verifique alimentação, rede, endereço do servidor e receiver aberto. Presença online é considerada recente por vinte segundos; depois pode aparecer atraso, e após noventa segundos, offline. Erro no link: confirme URL, acesso do servidor/TV, HTTPS e permissão de iframe.

Imagem sem exibição: verifique o arquivo na biblioteca e prefira PNG/JPEG. RTSP sem vídeo: confirme conectividade, URL, credenciais, FFmpeg, limite de streams e HLS nativo da TV. Login direto que não termina: confirme usuário e senha, Chromium disponível e, se necessário, os seletores em Opções avançadas.

Consulte `/api/health` e, com acesso administrativo, `/api/diagnostics` para saúde e backend ativo. Preserve os logs necessários sem divulgar credenciais. Faça backups consistentes periódicos e ensaie restauração; a cópia automática de JSON não substitui a rotina de backup do PostgreSQL.

Para reverter, pare DVS, restaure o código anterior e, quando necessário, banco, mídias e chave do mesmo backup. A versão 0.6.8 não conhece o novo modo de imagem. Depois de restaurar, confira usuários, grupos, modos, zoom e uma TV por plataforma.
