# Registro de decisões

> As decisões com estado **Aprovada** orientam a implementação. Itens **A confirmar** não impedem o início, mas precisam ser resolvidos antes da fase indicada.

## Decisões aprovadas

| ID | Decisão | Motivo e consequência |
| --- | --- | --- |
| DEC-001 | O produto terá um portal profissional e um portal do cliente na mesma plataforma. | Reutiliza identidade, regras, dados e infraestrutura, mantendo experiências adequadas a cada perfil. |
| DEC-002 | A arquitetura será multiempresa desde o primeiro esquema de dados. | Atende profissional autônomo e clínica com equipe sem uma migração estrutural posterior. Todo dado de negócio terá vínculo obrigatório com uma clínica. |
| DEC-003 | Os papéis iniciais serão proprietário, administrador, profissional, recepção/financeiro e cliente. | Permissões serão concedidas por função e validadas no servidor. Nenhuma função confiará apenas em ocultação de interface. |
| DEC-004 | A aplicação web será mobile-first, responsiva e instalável como PWA. | O mesmo sistema atenderá celular e desktop, com operação rápida dentro da clínica. |
| DEC-005 | O Android compartilhará a aplicação web por meio de Capacitor. | Permite publicar na Play Store, usar push e adicionar integrações nativas sem manter duas interfaces independentes. |
| DEC-006 | O design seguirá o sistema **Clinical Serenity** e as telas Stitch existentes. | Serão preservados paleta verde clínica, Inter, cartões, navegação inferior no celular e densidade de interface operacional. Componentes serão adaptados para desktop e acessibilidade. |
| DEC-007 | “Cliente fixo” significa plano/contrato com reserva recorrente; “cliente rotativo” agenda conforme disponibilidade ou créditos. | A distinção afetará agenda, contratos, faturamento, relatórios e reposições. |
| DEC-008 | Turmas terão capacidade, participantes, sala e aparelhos/recursos opcionais. | Capacidade e conflitos serão validados de forma transacional para impedir overbooking. |
| DEC-009 | O Aviso de Interesse usará fila sequencial por ordem de entrada, com oferta temporária inicialmente configurada para 10 minutos. | Evita corrida injusta entre todos os interessados. Ao expirar, a oferta segue para o próximo. A estratégia poderá se tornar configurável. |
| DEC-010 | Check-in, cancelamento, falta e reposição obedecerão políticas configuráveis pela clínica. | Créditos de reposição terão origem, saldo, validade e histórico auditável. |
| DEC-011 | O backend será a autoridade para validação e autorização. | O cliente nunca poderá decidir clínica, permissão, preço, saldo, capacidade ou situação fiscal sem nova validação no servidor. |
| DEC-012 | O banco principal será PostgreSQL gerenciado, com Row-Level Security como camada adicional de isolamento. | O modelo é fortemente relacional e exige transações, consistência financeira e proteção multiempresa. A integração hospedada deverá ocorrer por HTTP. |
| DEC-013 | Notificações push usarão Firebase Cloud Messaging e não exibirão dados sensíveis na tela bloqueada. | A notificação informa apenas que existe uma atualização ou vaga, levando o usuário autenticado ao detalhe. |
| DEC-014 | NFS-e será implementada atrás de uma interface de provedor. | Permite usar integração direta com Navegantes/AtendeNet, padrão nacional ou gateway fiscal sem espalhar regras do fornecedor pelo produto. |
| DEC-015 | Emissão fiscal será assíncrona, idempotente e auditada. | Repetições, quedas e respostas tardias não podem gerar duas notas para a mesma operação. |
| DEC-016 | Hospedagem gratuita será usada somente para desenvolvimento e homologação com dados fictícios. | Dados reais de saúde e fiscais só entram após infraestrutura com backup, restauração, monitoramento e condições operacionais adequadas. |
| DEC-017 | Não será prometida “segurança 100%”. | O compromisso verificável é segurança por projeto, defesa em profundidade, testes contínuos e bloqueio do lançamento diante de risco crítico conhecido. |
| DEC-018 | O primeiro recorte implementado será Dashboard + Agenda com dados demonstrativos. | Entrega rapidamente uma superfície reconhecível do produto antes das áreas secundárias, sem criar uma página promocional como tela principal. |
| DEC-019 | Dados clínicos, financeiros, fiscais ou tokens não serão armazenados em `localStorage`. | Armazenamento local será limitado a preferências não sensíveis e cache explicitamente seguro. |
| DEC-020 | Exclusões relevantes serão lógicas ou substituídas por cancelamento/estorno. | Preserva histórico, auditoria e reconciliação. Eliminação definitiva seguirá política de retenção e LGPD. |
| DEC-021 | O Contato inicial abrirá telefone, e-mail ou link de WhatsApp configurado pela clínica, sem chat interno ou WhatsApp Business API. | Entrega um caminho simples e seguro sem armazenar mensagens; uma integração oficial poderá ser avaliada separadamente. |
| DEC-022 | O primeiro ciclo financeiro usa BRL em centavos, vencimento inclusivo, saldo derivado de lançamentos append-only e nenhuma multa, juros ou desconto automático. | Pagamento parcial e estorno preservam o principal; cancelamento só ocorre sem lançamentos e recorrências mensais geram parcelas independentes e idempotentes. Consulte `FIN-001.md`. |
| DEC-023 | A taxa de cartão de crédito e meios de pagamento é despesa operacional da clínica e não interfere no valor recebido/atribuído ao profissional. | Garante integridade e previsibilidade da remuneração profissional; taxas de maquininha e operadoras são lançadas em contas a pagar (despesas bancárias da empresa) e não reduzem o valor bruto da consulta, aula ou repasse. |

## Decisões que podem ser tomadas durante a implementação

Estas escolhas são técnicas e podem ser decididas no início de cada tarefa, desde que não contrariem as decisões acima:

- Biblioteca exata de calendário, após validar acessibilidade, recorrência, turmas e uso móvel.
- Serviço de e-mail transacional.
- Ferramenta de observabilidade e rastreamento de erros.
- Gateway de pagamento, caso pagamento on-line entre no escopo futuro.
- Serviço intermediário de NFS-e, caso a integração direta não seja homologável.

## Pontos a confirmar com o responsável pelo negócio

| ID | Decisão pendente | Necessária antes de |
| --- | --- | --- |
| NEG-001 | Nome definitivo, domínio, logotipo e responsável legal pelo produto. | Publicação externa e Play Store. |
| NEG-002 | Regras de cancelamento, falta, antecedência mínima, expiração e geração de reposição. | Implementar reposições. |
| NEG-003 | Se a fila de interesse de 10 minutos será padrão global ou configurável por modalidade. | Finalizar Aviso de Interesse. |
| NEG-004 | Campos clínicos obrigatórios para Pilates, fisioterapia e médicos, incluindo anexos e assinaturas. | Implementar prontuário e avaliações. |
| NEG-006 | Dados tributários da clínica piloto: CNPJ, inscrição municipal, regime, CNAE, serviços, alíquotas e credenciais. | Homologar NFS-e. |
| NEG-008 | Quem será controlador, operador e canal de privacidade/LGPD. | Entrada de dados reais. |

## Fontes externas que precisam ser revalidadas

- A Prefeitura de Navegantes atualmente direciona a NFS-e para o portal AtendeNet: https://navegantes.sc.gov.br/nota-fiscal-eletronica-e-avulsa/
- Documentação vigente da NFS-e Nacional: https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/documentacao-atual
- Guia de segurança da ANPD: https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-sobre-seguranca-da-informacao-para-agentes-de-tratamento-de-pequeno-porte
- Requisitos vigentes de API alvo da Play Store: https://developer.android.com/google/play/requirements/target-sdk

Essas fontes são temporais e devem ser conferidas novamente na tarefa que depende delas.
