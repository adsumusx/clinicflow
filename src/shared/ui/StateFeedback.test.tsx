import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './Button'
import {
  EmptyState,
  ErrorState,
  LoadingState,
  SuccessState,
} from './StateFeedback'

describe('estados compartilhados', () => {
  it('identifica o carregamento como uma atualização ocupada', () => {
    render(
      <LoadingState
        title="Carregando agenda"
        description="Buscando os atendimentos do dia."
      />,
    )

    const state = screen.getByRole('status', { name: 'Carregando agenda' })
    expect(state).toHaveAttribute('aria-busy', 'true')
    expect(state).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByText('Buscando os atendimentos do dia.')).toBeInTheDocument()
  })

  it('oferece uma ação contextual no estado vazio', () => {
    const onCreate = vi.fn()
    render(
      <EmptyState
        title="Nenhum agendamento"
        description="Crie o primeiro atendimento deste dia."
        action={<Button onClick={onCreate}>Novo agendamento</Button>}
      />,
    )

    expect(
      screen.getByRole('region', { name: 'Nenhum agendamento' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Novo agendamento' }))
    expect(onCreate).toHaveBeenCalledOnce()
  })

  it('anuncia erros imediatamente e permite tentar de novo', () => {
    const onRetry = vi.fn()
    render(
      <ErrorState
        compact
        title="Não foi possível carregar"
        description="Confira sua conexão e tente novamente."
        action={<Button onClick={onRetry}>Tentar novamente</Button>}
      />,
    )

    const state = screen.getByRole('alert', {
      name: 'Não foi possível carregar',
    })
    expect(state).toHaveAttribute('aria-live', 'assertive')
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('anuncia a confirmação de sucesso de forma não intrusiva', () => {
    render(
      <SuccessState
        title="Agendamento confirmado"
        description="O horário foi reservado para Lucas Mendes."
      />,
    )

    expect(
      screen.getByRole('status', { name: 'Agendamento confirmado' }),
    ).toHaveAttribute('aria-live', 'polite')
  })
})
