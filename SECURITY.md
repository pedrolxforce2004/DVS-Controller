# Segurança

Encaminhe relatos ao responsável pelo repositório por canal privado, incluindo versão, impacto e reprodução em ambiente isolado. Não publique credenciais ou dados de clientes em issues.

A 0.6.8 restringe ACL dos dados e cofre webOS, exclui certificados da distribuição, reduz a resposta autenticada das TVs ao conteúdo atribuído, bloqueia edição/exclusão por Operador e falha explicitamente quando a configuração está corrompida. Dependências corrigidas estão no lockfile.

Use HTTPS, contas individuais, backup protegido e firewall. O dashboard de monitoramento exige uma sessão autenticada e não deve ser exposto publicamente. O cadastro inicial de TV não tem fila de aprovação; restrinja a rede que alcança o serviço. URLs internas são permitidas por necessidade funcional: limite a saída do servidor e bloqueie serviços administrativos/metadados no segmento de renderização. Somente pessoas confiáveis devem cadastrar painéis.

Não exponha PostgreSQL, controle local, ADB, SDB ou SSH das TVs à Internet. O gerenciador local requer elevação após o endurecimento de ACL. Auditoria sem ocorrências não garante ausência de falhas. Consulte as limitações e procedimentos no manual.
