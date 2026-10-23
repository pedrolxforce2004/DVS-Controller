# DVS Controller 0.6.8

Gestão centralizada de painéis em LG webOS, Samsung Tizen e Android TV. Servidor Node.js, administração web, gerenciador Windows e persistência PostgreSQL com compatibilidade JSON.

## Documentação

- [Manual completo de produção](docs/MANUAL-0.6.8.md)
- [Manual em PDF](docs/DVS-Controller-0.6.8-Manual.pdf)
- [Referência técnica do código](docs/CODE-REFERENCE-0.6.8.md)
- [Relatório de build 0.6.8](docs/BUILD-0.6.8.md)
- [Segurança](SECURITY.md) e [contribuição](CONTRIBUTING.md)

## Novidades

- WGT Tizen preserva o perfil escolhido, como `INFRA`, e usa perfil temporario apenas como fallback.
- Previews renderizados com cache/fila para reduzir rajadas de downloads e telas pretas.
- Sessao interativa renderizada mais leve, com comandos e atualizacao visual menos travados.
- Playlist de paineis com tempo de exibicao por item.
- Dashboard e grupos mais organizados.
- Cliente Android TV com watchdog para recuperar WebView travado apos tempo ligado ou reinicio.

## Desenvolvimento

Requer Node.js 22+. Execute `npm ci`, defina `DVS_DATA_DIR` para uma pasta exclusiva de desenvolvimento e use `npm run dev`. Acesse `http://localhost:3080/admin`. Em banco novo, o primeiro acesso é `admin` / `admin`, com troca obrigatória. Configure HTTPS antes de acesso remoto. `.env.example` não é carregado automaticamente.

`lib/`, `public/`, `manager/`, `service/` e clientes contêm produção. `tests/` contém testes/laboratório. `artifacts/` contém evidências e ferramentas locais, ignoradas pelo Git. Dados e certificados não devem ser publicados.

## Verificação e distribuição

```powershell
npm ci
npm test
npm audit
npm run dist:win
npm run release:source
```

O exportador cria `artifacts/github-0.6.8` usando uma lista explícita e excluindo dados, chaves e ferramentas locais. O instalador tem lista própria de produção. Leia o manual antes de atualizar uma instalação existente.

Android: JDK 17, Gradle 8.11.1, SDK 35 e `gradle -p android-client assembleDebug lint`. A assinatura de release usa variáveis de ambiente descritas no manual. Preserve a chave para futuras atualizações.

Homologação física e ensaio do instalador sobre uma cópia dos dados continuam necessários antes da implantação. Nenhum comando de build implanta no servidor ativo.
