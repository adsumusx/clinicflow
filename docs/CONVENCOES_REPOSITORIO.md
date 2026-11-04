# Estrutura modular e convenções do repositório

> Padrões definidos na tarefa `DEV-002`. Este documento é a referência para código novo e revisões.

## 1. Estrutura da aplicação

```text
src/
├── app/                 # composição da aplicação, providers e roteamento
├── pages/               # páginas e composição de funcionalidades por rota
│   └── <pagina>/        # uma pasta e uma API pública por página
├── features/            # casos de uso e regras de uma capacidade do produto
│   └── <funcionalidade>/
├── shared/              # código reutilizável sem regra específica de negócio
│   ├── styles/          # tokens Clinical Serenity e estilos globais
│   └── ui/              # componentes visuais compartilhados
├── test/                # configuração e utilitários globais de teste
└── main.tsx             # único ponto de entrada do navegador
```

Pastas só devem ser criadas quando tiverem conteúdo. Por isso, `features/` passa a existir quando a primeira funcionalidade de negócio for implementada.

Cada página ou funcionalidade expõe sua API pública em um `index.ts`. Não deve existir um barril único para todo o repositório.

## 2. Direção das dependências

As camadas dependem apenas das camadas à sua direita:

```text
app → pages → features → shared
```

- `app` compõe páginas, funcionalidades e infraestrutura compartilhada.
- O shell profissional responsivo pertence a `app`, envolve o conteúdo das páginas e mantém uma única navegação adaptada por CSS entre celular e desktop.
- `pages` compõem funcionalidades e elementos compartilhados; não são importadas por funcionalidades.
- `features` podem colaborar com outras funcionalidades quando necessário, mas não conhecem páginas nem `app`.
- `shared` não conhece regras de negócio nem camadas superiores.
- imports entre módulos usam a API pública do módulo, como `@/shared/ui` e `@/pages/foundation`.
- imports relativos com `./` são usados apenas dentro da pasta atual. Para sair dela, usa-se o alias `@`.
- arquivos de estilo e outros ativos podem ser importados diretamente, como `@/shared/styles/global.css`.

O script `npm run check:imports` valida automaticamente imports ascendentes, dependências entre camadas, uso da API pública e declarações duplicadas de pacotes.

## 3. Organização dentro de um módulo

Uma página ou funcionalidade pode adotar estas pastas conforme crescer:

```text
<modulo>/
├── api/                 # contratos e chamadas HTTP do módulo
├── components/          # componentes privados do módulo
├── hooks/               # hooks React do módulo
├── model/               # tipos, estado e regras puras
├── tests/               # cenários amplos, quando a colocação não for suficiente
└── index.ts             # API pública mínima
```

Não se cria uma camada antecipadamente. Um arquivo permanece próximo de quem o usa e só vai para `shared` quando houver reutilização real e ausência de regra de negócio.

## 4. Imports e TypeScript

- O alias `@/*` aponta para `src/*` no TypeScript, Vite e Vitest.
- Imports de tipos usam `import type` quando não há valor em tempo de execução.
- Código novo deve permanecer no modo `strict`, sem `any` implícito e sem suprimir erro de tipo sem justificativa.
- Dados vindos de API, formulários ou armazenamento são desconhecidos até serem validados na fronteira apropriada.
- Componentes não devem ler dados clínicos, financeiros, fiscais ou tokens de `localStorage`.

## 5. Nomes e arquivos

- Componentes e seus arquivos: `PascalCase`, por exemplo `AppointmentCard.tsx`.
- Hooks: `use` + `PascalCase`, por exemplo `useAppointments.ts`.
- Funções, variáveis e propriedades: `camelCase`.
- Tipos e interfaces: `PascalCase`.
- Pastas de módulos e rotas: `kebab-case`.
- Testes unitários e de componente: `*.test.ts` ou `*.test.tsx`, ao lado do código testado.
- Arquivos públicos de módulo: `index.ts`, exportando apenas o contrato necessário aos consumidores.

O código e os identificadores técnicos ficam em inglês. Textos exibidos à pessoa usuária e documentação do produto ficam em português.

## 6. Componentes e estilos

- Componentes compartilhados devem aceitar propriedades nativas adequadas e preservar acessibilidade de teclado, foco, rótulos e estados.
- O destino atual da navegação deve usar `aria-current="page"`; atalhos de conteúdo devem continuar disponíveis por teclado.
- Regras de negócio não ficam em componentes de `shared/ui`.
- Estilos globais ficam em `shared/styles`; estilos específicos permanecem próximos do módulo que os usa.
- Nomes de classes usam uma convenção previsível de bloco, elemento e modificador, por exemplo `card`, `card__header` e `button--primary`.
- Cores, tipografia, espaçamento, sombras, raios, foco e movimento ficam centralizados em `shared/styles/tokens.css`.
- Tokens usam os prefixos `--color-`, `--font-`, `--line-height-`, `--letter-spacing-`, `--space-`, `--layout-`, `--radius-`, `--shadow-`, `--size-` e `--motion-`.
- Componentes e páginas consomem tokens sem repetir valores visuais literais. Novos tokens devem representar uma decisão reutilizável do sistema Clinical Serenity.

## 7. Dependências

- Uma biblioteca deve ter uma responsabilidade clara e não duplicar outra já adotada para o mesmo problema.
- Antes de adicionar um pacote, verificar se React, a plataforma web ou uma dependência existente já cobre o caso.
- Dependências usadas no navegador ficam em `dependencies`; ferramentas de build e teste ficam em `devDependencies`.
- Versões permanecem exatas e o `package-lock.json` deve acompanhar mudanças.
- Uma nova dependência exige uso imediato, justificativa na revisão e execução de `npm run check`.

## 8. Scripts oficiais

| Comando | Finalidade |
| --- | --- |
| `npm run dev` | inicia o servidor local do Vite |
| `npm run build` | verifica tipos e gera a distribuição de produção |
| `npm run preview` | serve localmente a distribuição gerada |
| `npm run check:imports` | valida fronteiras modulares e dependências duplicadas |
| `npm run typecheck` | executa o TypeScript sem emitir arquivos |
| `npm test` | executa toda a suíte uma vez |
| `npm run test:watch` | acompanha testes durante o desenvolvimento |
| `npm run check` | executa todas as verificações obrigatórias e o build |

Antes de considerar uma tarefa de implementação concluída, deve-se executar `npm run check` e registrar qualquer exceção relevante.
