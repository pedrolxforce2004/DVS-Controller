# Contribuição

Use Node.js 22+, `npm ci` e `npm test`. Os testes criam dados temporários; nunca aponte testes para produção. Evidências ficam em `artifacts/evidence/`.

Preserve IDs de aplicativos, nomes de serviços e caminhos de dados. Alterações de persistência exigem ensaio com dados anteriores, backup e retorno documentado. Não reinicialize PostgreSQL existente.

Android requer JDK 17, SDK 35 e Gradle 8.11.1. Execute `gradle -p android-client assembleDebug lint`; release exige assinatura permanente. Não envie chaves, certificados ou `local.properties`.

Antes de contribuir, rode testes pertinentes, `npm audit` e `npm run release:source`. Descreva problema, resultado, evidências e limites. SDKs e PostgreSQL locais são necessários para testes correspondentes; informe testes ignorados.
