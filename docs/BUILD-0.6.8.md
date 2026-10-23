# DVS Controller 0.6.8 - Relatorio de build

Data: 30 de setembro de 2026.

## Artefatos gerados

| Artefato | Status | Caminho |
| --- | --- | --- |
| Instalador Windows | Gerado | `dist/DVS-Controller-Setup-0.6.8.exe` |
| Blockmap Windows | Gerado | `dist/DVS-Controller-Setup-0.6.8.exe.blockmap` |
| Receiver webOS IPK | Gerado | `dist/DVS-Receiver-webOS-0.6.8.ipk` |
| IPK raiz webOS | Gerado | `com.decode.dvscontroller_0.6.8_all.ipk` |
| Receiver Android TV APK | Gerado | `dist/DVS-Receiver-0.6.8.apk` |
| Manual PDF | Disponivel | `docs/DVS-Controller-0.6.8-Manual.pdf` e `dist/DVS-Controller-0.6.8-Manual.pdf` |
| Checksums | Gerado | `dist/SHA256SUMS-0.6.8.txt` |

## Bloqueios

### Tizen WGT

Nao foi possivel gerar um WGT assinado com perfil `INFRA` porque o Tizen Studio local nao possui `<profile name="INFRA">` em `C:\tizen-studio-data\profile\profiles.xml`. O arquivo contem `active="INFRA"`, mas o unico perfil cadastrado e `DVS_INFRA_1789756681394_1176`, resquicio da versao anterior.

Ao tentar usar esse perfil existente, o Tizen CLI falhou ao ler a senha salva:

`Author password: An error has occurred. See the log file tizen-studio-data\cli\logs\cli.log.`

Para concluir:

1. Abra Samsung/Tizen Certificate Manager.
2. Recrie ou renomeie o perfil para `INFRA`.
3. Confirme que `tizen security-profiles list` mostra `INFRA`.
4. Gere o WGT pelo DVS Controller ou execute o empacotamento novamente.

## Observacoes

- Arquivos 0.6.7 versionados foram removidos de `dist`, `docs` e raiz do projeto.
- `node_modules` foi restaurado com `npm ci`.
- O APK Android TV 0.6.8 foi gerado com toolchain local em `artifacts/toolchain` e embutido no instalador Windows em `dist/win-unpacked/resources/android/DVS-Receiver-0.6.8.apk`.
- Revisao final de producao: eliminada a reconstrucao dos cards durante telemetria, previews limitados e cancelados fora do Dashboard, e sessao interativa priorizada para evitar atraso e tela branca.
- Conexao real validada na Samsung `192.168.193.177:26101`: modelo `LS32H5000FGXZD`, Tizen 8.0, estado SDB `device`. O gerenciador agora recupera automaticamente a corrida de inicializacao do daemon SDB.
- O instalador Windows foi reconstruido apos a correcao do servico existente (`DVSControllerService`) para homologacao em maquinas que ja tiveram versoes anteriores.
- `npm audit --omit=dev` reportou zero vulnerabilidades nas dependencias de producao. O aviso de 3 vulnerabilidades altas do `npm ci` esta restrito a ferramentas de desenvolvimento que o empacotador remove do aplicativo final.
