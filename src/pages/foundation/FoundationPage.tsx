import { Button, Card, StatusBadge } from '@/shared/ui'

const foundations = [
  'Navegação inferior otimizada para toque',
  'Barra lateral estável em telas amplas',
  'Destino atual identificado de forma acessível',
  'Cabeçalho e conteúdo adaptáveis',
]

export function FoundationPage() {
  return (
    <section className="welcome" aria-labelledby="page-title">
      <div className="welcome__eyebrow">
        <StatusBadge tone="success">Shell responsivo</StatusBadge>
        <span>M1 · DES-002</span>
      </div>

      <h1 id="page-title">Experiência profissional</h1>
      <p className="welcome__subtitle">
        A navegação do ClinicFlow acompanha a rotina da clínica no celular e
        aproveita o espaço disponível no desktop.
      </p>

      <Card
        title="Estrutura pronta para as páginas"
        description="O mesmo shell receberá Dashboard, Agenda, Clientes e Financeiro sem duplicar navegação."
        footer={
          <Button type="button" onClick={() => window.location.reload()}>
            Verificar interface
          </Button>
        }
      >
        <ul className="foundation-list">
          {foundations.map((foundation) => (
            <li key={foundation}>{foundation}</li>
          ))}
        </ul>
      </Card>
    </section>
  )
}
