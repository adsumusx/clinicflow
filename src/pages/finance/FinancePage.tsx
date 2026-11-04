import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '@/features/auth'
import {
  cancelPayable, cancelReceivable, createFinancialCategory, createPayable, createPayablePayment,
  createReceivable, createReceivablePayment, generateContractReceivables, getPayable, getReceivable, listPayables,
  listReceivables, reversePayablePayment, reverseReceivablePayment, updatePayable, updateReceivable,
  type FinancialPayment, type FinancialPaymentMethod, type Payable, type PayableInput,
  type PayablesResult, type Receivable, type ReceivableInput, type ReceivablesResult,
  type ReceivableStatus,
} from '@/features/finance'
import { Button, Card, EmptyState, ErrorState, LoadingState, StatusBadge } from '@/shared/ui'
import './FinancePage.css'

type FinanceMode = 'receivable' | 'payable'
type FinancialRecord = Receivable | Payable
const emptyReceivables: ReceivablesResult = { items: [], options: { categories: [], clients: [] }, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 }, summary: { count: 0, openBalanceCents: 0, overdueBalanceCents: 0 } }
const emptyPayables: PayablesResult = { items: [], options: { categories: [] }, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 }, summary: { count: 0, openBalanceCents: 0, overdueBalanceCents: 0 } }
const statusLabels: Record<ReceivableStatus, string> = { open: 'Em aberto', partially_paid: 'Parcial', paid: 'Pago', overdue: 'Vencido', cancelled: 'Cancelado' }
const methodLabels: Record<FinancialPaymentMethod, string> = { pix: 'Pix', cash: 'Dinheiro', credit_card: 'Cartão de crédito', debit_card: 'Cartão de débito', transfer: 'Transferência', boleto: 'Boleto', other: 'Outro' }
const currency = (value: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value / 100)
const localDate = (value: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`))
function cents(value: FormDataEntryValue | null) {
  const raw = String(value ?? '').trim().replace(/\s/g, '').replace(/^R\$/i, '')
  if (!raw) return Number.NaN
  let normalized = raw
  if (raw.includes(',') && raw.includes('.')) normalized = raw.replace(/\./g, '').replace(',', '.')
  else if (raw.includes(',')) normalized = raw.replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(raw)) normalized = raw.replace(/\./g, '')
  if (!/^\d+(\.\d+)?$/.test(normalized)) return Number.NaN
  const amount = Number(normalized)
  return Number.isFinite(amount) ? Math.round(amount * 100) : Number.NaN
}

function fieldLabel(control: Element) {
  const label = control.closest('label')
  const text = [...(label?.childNodes ?? [])].find((node) => node.nodeType === Node.TEXT_NODE)?.textContent ?? ''
  return text.replace(/\s+/g, ' ').trim()
}

function formIssue(form: HTMLFormElement) {
  for (const control of form.elements) {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) continue
    if (control.disabled || control.type === 'checkbox' || control.type === 'button' || control.type === 'submit') continue
    if (control.validity.valid) continue
    const label = fieldLabel(control) || 'o campo'
    if (control.validity.valueMissing) return `Preencha ${label}.`
    if (control.validity.tooShort) return `${label} está curto demais.`
    if (control.validity.tooLong) return `${label} está longo demais.`
    return `Revise ${label}.`
  }
  return null
}

function positiveAmount(value: number) {
  return Number.isSafeInteger(value) && value >= 1
}
const createUniqueId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}
const key = (scope: string) => `${scope}:${createUniqueId()}`

interface PaymentPartDraft {
  id: string
  amount: string
  method: FinancialPaymentMethod
  externalReference: string
}

export function FinancePage() {
  const { session } = useAuth()
  const [mode, setMode] = useState<FinanceMode>('receivable')
  const [receivables, setReceivables] = useState<ReceivablesResult>(emptyReceivables)
  const [payables, setPayables] = useState<PayablesResult>(emptyPayables)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [generatorOpen, setGeneratorOpen] = useState(false)
  const [editing, setEditing] = useState<FinancialRecord | null>(null)
  const [cancelling, setCancelling] = useState<FinancialRecord | null>(null)
  const [detail, setDetail] = useState<FinancialRecord | null>(null)
  const [paymentTarget, setPaymentTarget] = useState<FinancialRecord | null>(null)
  const [reversal, setReversal] = useState<{ payment: FinancialPayment; record: FinancialRecord } | null>(null)
  const [recurring, setRecurring] = useState(false)
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ReceivableStatus | ''>('')
  const [page, setPage] = useState(1)

  // Split payment state
  const [splitPayment, setSplitPayment] = useState(false)
  const [paymentParts, setPaymentParts] = useState<PaymentPartDraft[]>([])
  const [composerPayImmediately, setComposerPayImmediately] = useState(false)
  const [composerSplitPayment, setComposerSplitPayment] = useState(false)
  const [composerPaymentParts, setComposerPaymentParts] = useState<PaymentPartDraft[]>([])
  const [composerAmountDraft, setComposerAmountDraft] = useState('')
  const [prefillDraft, setPrefillDraft] = useState<{ clientId?: string; description?: string } | null>(null)

  const organization = session?.organizations.find(({ id }) => id === session.organizationId)
  const canRead = organization?.permissions.includes('finance.read') ?? false
  const canManage = organization?.permissions.includes('finance.manage') ?? false
  const result = mode === 'receivable' ? receivables : payables

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem('prefill_receivable')
      if (stored) {
        sessionStorage.removeItem('prefill_receivable')
        const parsed = JSON.parse(stored)
        if (parsed && typeof parsed === 'object') {
          setPrefillDraft(parsed)
          setComposerPayImmediately(true)
          setComposerOpen(true)
        }
      }
    } catch {}
  }, [])

  async function load() {
    if (!session?.organizationId || !canRead) { setLoading(false); return }
    setLoading(true); setError(null)
    try {
      if (mode === 'receivable') setReceivables(await listReceivables(session.organizationId, { page, search, status }))
      else setPayables(await listPayables(session.organizationId, { page, search, status }))
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível carregar o financeiro.') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [session?.organizationId, canRead, mode, page, search, status])

  function resetPanels() {
    setComposerOpen(false); setCategoryOpen(false); setGeneratorOpen(false); setEditing(null)
    setCancelling(null); setDetail(null); setPaymentTarget(null); setReversal(null)
    setSplitPayment(false); setPaymentParts([]); setComposerPayImmediately(false)
    setComposerSplitPayment(false); setComposerPaymentParts([]); setComposerAmountDraft('')
    setPrefillDraft(null); setError(null)
  }
  function switchMode(next: FinanceMode) { resetPanels(); setMessage(null); setMode(next); setPage(1); setSearch(''); setSearchDraft(''); setStatus('') }
  function openComposer(record: FinancialRecord | null = null) {
    resetPanels(); setEditing(record); setRecurring(false)
    setComposerAmountDraft(record ? (record.originalAmountCents / 100).toFixed(2).replace('.', ',') : '')
    setComposerOpen(true)
  }

  function openPayment(record: FinancialRecord) {
    resetPanels()
    setPaymentTarget(record)
    setSplitPayment(false)
    const half = Math.floor(record.balanceCents / 2)
    setPaymentParts([
      { id: createUniqueId(), amount: (half / 100).toFixed(2).replace('.', ','), method: 'cash', externalReference: '' },
      { id: createUniqueId(), amount: ((record.balanceCents - half) / 100).toFixed(2).replace('.', ','), method: 'credit_card', externalReference: '' },
    ])
  }

  function updatePaymentPart(id: string, updates: Partial<PaymentPartDraft>) {
    setPaymentParts((prev) => prev.map((p) => (p.id === id ? { ...p, ...updates } : p)))
  }
  function revealLastPart() {
    requestAnimationFrame(() => {
      const last = document.querySelector('.finance-split-parts li:last-child')
      if (last && typeof last.scrollIntoView === 'function') last.scrollIntoView({ block: 'nearest' })
    })
  }

  function addPaymentPart() {
    const curSum = paymentParts.reduce((s, p) => s + cents(p.amount), 0)
    const remaining = Math.max(0, (paymentTarget?.balanceCents ?? 0) - curSum)
    setPaymentParts((prev) => [
      ...prev,
      { id: createUniqueId(), amount: (remaining / 100).toFixed(2).replace('.', ','), method: 'pix', externalReference: '' },
    ])
    revealLastPart()
  }
  function removePaymentPart(id: string) {
    setPaymentParts((prev) => prev.filter((p) => p.id !== id))
  }

  function updateComposerPaymentPart(id: string, updates: Partial<PaymentPartDraft>) {
    setComposerPaymentParts((prev) => prev.map((p) => (p.id === id ? { ...p, ...updates } : p)))
  }
  function addComposerPaymentPart() {
    const total = cents(composerAmountDraft)
    const curSum = composerPaymentParts.reduce((s, p) => s + cents(p.amount), 0)
    const remaining = Math.max(0, total - curSum)
    setComposerPaymentParts((prev) => [
      ...prev,
      { id: createUniqueId(), amount: (remaining / 100).toFixed(2).replace('.', ','), method: 'pix', externalReference: '' },
    ])
    revealLastPart()
  }
  function removeComposerPaymentPart(id: string) {
    setComposerPaymentParts((prev) => prev.filter((p) => p.id !== id))
  }

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!session?.organizationId) return
    const invalid = formIssue(event.currentTarget)
    if (invalid) { setMessage(null); setError(invalid); return }
    const data = new FormData(event.currentTarget)
    const amountCents = cents(data.get('amount'))
    if (!positiveAmount(amountCents)) {
      setMessage(null)
      setError('Informe um valor positivo. Exemplo: 150,00 ou 1.500,00.')
      return
    }
    const common = {
      amountCents,
      categoryId: String(data.get('categoryId') ?? ''),
      competenceOn: `${data.get('competenceMonth')}-01`,
      description: String(data.get('description') ?? ''),
      dueOn: String(data.get('dueOn') ?? ''),
      idempotencyKey: key(mode),
      recurrence: recurring ? { frequency: 'monthly' as const, installmentCount: Number(data.get('installmentCount')) } : null,
    }
    setSaving(true); setError(null)
    let createdId: string | null = null
    try {
      if (mode === 'receivable') {
        const input: ReceivableInput = { ...common, clientId: String(data.get('clientId') ?? '') }
        if (editing) {
          await updateReceivable(session.organizationId, editing.id, input)
        } else {
          const res = await createReceivable(session.organizationId, input)
          createdId = res.items[0]?.id ?? null
        }
      } else {
        const input: PayableInput = { ...common, counterparty: String(data.get('counterparty') ?? '') }
        if (editing) {
          await updatePayable(session.organizationId, editing.id, input)
        } else {
          const res = await createPayable(session.organizationId, input)
          createdId = res.items[0]?.id ?? null
        }
      }

      if (!editing && !recurring && composerPayImmediately && createdId) {
        const paidAt = new Date(String(data.get('composerPaidAt') || currentDateTime)).toISOString()
        if (composerSplitPayment) {
          const partsTotal = composerPaymentParts.reduce((s, p) => s + cents(p.amount), 0)
          if (composerPaymentParts.some((part) => !positiveAmount(cents(part.amount)))) {
            throw new Error('Cada parte do pagamento precisa ter um valor maior que zero.')
          }
          if (partsTotal <= 0) throw new Error('Informe o valor das partes do pagamento.')
          if (partsTotal > amountCents) {
            throw new Error(`A soma das partes (${currency(partsTotal)}) não pode superar o valor da conta (${currency(amountCents)}).`)
          }
          const payments = composerPaymentParts.map((part, index) => ({
            amountCents: cents(part.amount),
            method: part.method,
            externalReference: part.externalReference.trim() || null,
            paidAt,
            idempotencyKey: key(`${mode}:payment:${index + 1}`),
          }))
          if (mode === 'receivable') {
            await createReceivablePayment(session.organizationId, createdId, { payments })
          } else {
            await createPayablePayment(session.organizationId, createdId, { payments })
          }
        } else {
          const paymentInput = {
            amountCents,
            method: String(data.get('composerMethod') || 'pix') as FinancialPaymentMethod,
            externalReference: String(data.get('composerReference') ?? '') || null,
            paidAt,
            idempotencyKey: key(`${mode}:payment`),
          }
          if (mode === 'receivable') {
            await createReceivablePayment(session.organizationId, createdId, paymentInput)
          } else {
            await createPayablePayment(session.organizationId, createdId, paymentInput)
          }
        }
      }

      setMessage(
        editing
          ? 'Conta atualizada com sucesso.'
          : recurring
          ? 'Série mensal criada com sucesso.'
          : composerPayImmediately
          ? mode === 'receivable'
            ? 'Conta criada e recebimento registrado com sucesso.'
            : 'Despesa criada e baixa registrada com sucesso.'
          : mode === 'receivable'
          ? 'Conta criada com sucesso.'
          : 'Despesa criada com sucesso.',
      )
      setComposerOpen(false); setEditing(null); await load()
    } catch (requestError) {
      const detail = requestError instanceof Error ? requestError.message : 'Não foi possível salvar a conta.'
      setMessage(null)
      setError(createdId ? `A conta foi salva, mas o pagamento não foi registrado. ${detail}` : detail)
      if (createdId) { setComposerOpen(false); setEditing(null); await load() }
    } finally {
      setSaving(false)
    }
  }

  async function saveCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!session?.organizationId) return
    const invalid = formIssue(event.currentTarget)
    if (invalid) { setMessage(null); setError(invalid); return }
    setSaving(true); setError(null)
    try { await createFinancialCategory(session.organizationId, { name: String(new FormData(event.currentTarget).get('name') ?? ''), kind: mode }); setCategoryOpen(false); setMessage('Categoria salva com sucesso.'); await load() }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível salvar a categoria.') }
    finally { setSaving(false) }
  }

  async function generateBilling(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!session?.organizationId) return
    const invalid = formIssue(event.currentTarget)
    if (invalid) { setMessage(null); setError(invalid); return }
    const data = new FormData(event.currentTarget)
    setSaving(true); setError(null)
    try {
      const generated = await generateContractReceivables(session.organizationId, {
        categoryId: String(data.get('categoryId') ?? ''),
        competenceOn: `${data.get('competenceMonth')}-01`,
        idempotencyKey: key('contract-billing'),
      })
      setGeneratorOpen(false)
      setMessage(generated.generatedCount
        ? `${generated.generatedCount} ${generated.generatedCount === 1 ? 'mensalidade gerada' : 'mensalidades geradas'} com sucesso.`
        : 'A competência já estava gerada ou não possui contratos ativos.')
      await load()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível gerar as mensalidades.')
    } finally { setSaving(false) }
  }

  async function cancelAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!session?.organizationId || !cancelling) return
    const invalid = formIssue(event.currentTarget)
    if (invalid) { setMessage(null); setError(invalid); return }
    setSaving(true); setError(null)
    try { const reason = String(new FormData(event.currentTarget).get('reason') ?? ''); if (mode === 'receivable') await cancelReceivable(session.organizationId, cancelling.id, reason); else await cancelPayable(session.organizationId, cancelling.id, reason); setCancelling(null); setMessage('Conta cancelada. O histórico foi preservado.'); await load() }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível cancelar a conta.') }
    finally { setSaving(false) }
  }

  async function showDetail(record: FinancialRecord) {
    if (!session?.organizationId) return; resetPanels()
    try { setDetail(mode === 'receivable' ? await getReceivable(session.organizationId, record.id) : await getPayable(session.organizationId, record.id)) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível abrir o histórico.') }
  }

  async function savePayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!session?.organizationId || !paymentTarget) return
    const invalid = formIssue(event.currentTarget)
    if (invalid) { setMessage(null); setError(invalid); return }
    const data = new FormData(event.currentTarget)
    const paidAtDate = new Date(String(data.get('paidAt')))
    if (Number.isNaN(paidAtDate.getTime())) { setMessage(null); setError('Informe a data e a hora do lançamento.'); return }
    const paidAt = paidAtDate.toISOString()
    setSaving(true); setError(null)
    try {
      if (splitPayment) {
        const partsTotal = paymentParts.reduce((s, p) => s + cents(p.amount), 0)
        if (paymentParts.some((part) => !positiveAmount(cents(part.amount)))) {
          throw new Error('Cada parte do pagamento precisa ter um valor maior que zero.')
        }
        if (partsTotal <= 0) throw new Error('Informe o valor das partes do pagamento.')
        if (partsTotal > paymentTarget.balanceCents) {
          throw new Error(`A soma das partes (${currency(partsTotal)}) não pode superar o saldo (${currency(paymentTarget.balanceCents)}).`)
        }
        const payments = paymentParts.map((part, index) => ({
          amountCents: cents(part.amount),
          method: part.method,
          externalReference: part.externalReference.trim() || null,
          paidAt,
          idempotencyKey: key(`${mode}:payment:${index + 1}`),
        }))
        if (mode === 'receivable') {
          await createReceivablePayment(session.organizationId, paymentTarget.id, { payments })
        } else {
          await createPayablePayment(session.organizationId, paymentTarget.id, { payments })
        }
        const record = paymentTarget
        setPaymentTarget(null)
        setMessage(mode === 'receivable' ? `Recebimento em ${payments.length} partes registrado com sucesso.` : `Baixa em ${payments.length} partes registrada com sucesso.`)
        await load()
        await showDetail(record)
      } else {
        const amountCents = cents(data.get('amount'))
        if (!positiveAmount(amountCents)) throw new Error('Informe um valor positivo. Exemplo: 150,00 ou 1.500,00.')
        const input = {
          amountCents,
          externalReference: String(data.get('externalReference') ?? '') || null,
          idempotencyKey: key(`${mode}:payment`),
          method: String(data.get('method')) as FinancialPaymentMethod,
          paidAt,
        }
        if (mode === 'receivable') {
          await createReceivablePayment(session.organizationId, paymentTarget.id, input)
        } else {
          await createPayablePayment(session.organizationId, paymentTarget.id, input)
        }
        const record = paymentTarget
        setPaymentTarget(null)
        setMessage(mode === 'receivable' ? 'Recebimento registrado.' : 'Baixa registrada.')
        await load()
        await showDetail(record)
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível registrar o lançamento.')
    } finally {
      setSaving(false)
    }
  }

  async function reversePayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!session?.organizationId || !reversal) return
    const invalid = formIssue(event.currentTarget)
    if (invalid) { setMessage(null); setError(invalid); return }
    const input = { idempotencyKey: key(`${mode}:reversal`), reason: String(new FormData(event.currentTarget).get('reason') ?? ''), reversedAt: new Date().toISOString() }
    setSaving(true); setError(null)
    try { if (mode === 'receivable') await reverseReceivablePayment(session.organizationId, reversal.record.id, reversal.payment.id, input); else await reversePayablePayment(session.organizationId, reversal.record.id, reversal.payment.id, input); const record = reversal.record; setReversal(null); setMessage('Estorno registrado sem apagar o lançamento original.'); await load(); await showDetail(record) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível registrar o estorno.') }
    finally { setSaving(false) }
  }

  const today = new Date().toISOString().slice(0, 10)
  const currentDateTime = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  const records = result.items as FinancialRecord[]

  const partsSumCents = paymentParts.reduce((s, p) => s + cents(p.amount), 0)
  const remainingBalanceCents = (paymentTarget?.balanceCents ?? 0) - partsSumCents
  const composerTotalCents = cents(composerAmountDraft)
  const composerPartsSumCents = composerPaymentParts.reduce((s, p) => s + cents(p.amount), 0)
  const composerRemainingCents = composerTotalCents - composerPartsSumCents
  const formError = error ? <div className="finance-form__wide"><ErrorState compact title="Não foi possível concluir" description={error} /></div> : null
  const formPanelOpen = categoryOpen || generatorOpen || composerOpen || Boolean(paymentTarget || cancelling || reversal)

  return <section className="finance-page" aria-labelledby="finance-title">
    <header className="finance-page__header"><div><span>M5 · Financeiro</span><h1 id="finance-title">{mode === 'receivable' ? 'Contas a receber' : 'Contas a pagar'}</h1><p>Recebimentos, despesas e saldos conciliados de {organization?.name}.</p></div>{canManage && <div className="finance-page__header-actions"><Button type="button" variant="secondary" onClick={() => { resetPanels(); setCategoryOpen(true) }}>Nova categoria</Button>{mode === 'receivable' && <Button type="button" variant="secondary" onClick={() => { resetPanels(); setGeneratorOpen(true) }}>Gerar mensalidades</Button>}<Button type="button" onClick={() => openComposer()}>{mode === 'receivable' ? 'Nova conta' : 'Nova despesa'}</Button></div>}</header>
    <nav className="finance-tabs" aria-label="Áreas do financeiro"><button type="button" aria-current={mode === 'receivable' ? 'page' : undefined} onClick={() => switchMode('receivable')}>Contas a receber</button><button type="button" aria-current={mode === 'payable' ? 'page' : undefined} onClick={() => switchMode('payable')}>Contas a pagar</button></nav>
    {message && <p className="finance-page__message" role="status">{message}</p>}{error && !formPanelOpen && <ErrorState compact title="Não foi possível concluir" description={error} />}
    {canRead && <div className="finance-summary" aria-label="Resumo financeiro"><Card title="Saldo em aberto"><strong>{currency(result.summary.openBalanceCents)}</strong><small>{result.summary.count} contas pendentes</small></Card><Card title="Saldo vencido"><strong>{currency(result.summary.overdueBalanceCents)}</strong><small>Exige acompanhamento</small></Card><Card title="Total cadastrado"><strong>{result.pagination.total}</strong><small>No filtro atual</small></Card></div>}
    {categoryOpen && canManage && <Card title="Nova categoria financeira" description={`Disponível em contas a ${mode === 'receivable' ? 'receber' : 'pagar'}.`}><form className="finance-category" noValidate onSubmit={saveCategory}>{formError}<label>Nome<input name="name" required minLength={2} maxLength={120} /></label><div><Button type="submit" loading={saving}>Salvar categoria</Button><Button type="button" variant="secondary" onClick={() => setCategoryOpen(false)}>Cancelar</Button></div></form></Card>}
    {generatorOpen && canManage && mode === 'receivable' && <Card title="Gerar mensalidades dos contratos" description="Cria uma cobrança por contrato ativo na competência, sem duplicar uma cobrança já existente."><form className="finance-form" noValidate onSubmit={generateBilling}>{formError}<label>Competência<input name="competenceMonth" type="month" required defaultValue={today.slice(0, 7)} /></label><label>Categoria<select name="categoryId" required defaultValue=""><option value="" disabled>Selecione</option>{receivables.options.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="finance-form__actions"><Button type="submit" loading={saving}>Gerar cobranças</Button><Button type="button" variant="secondary" onClick={() => setGeneratorOpen(false)}>Cancelar</Button></div></form></Card>}
    {composerOpen && canManage && <Card title={editing ? 'Editar conta' : mode === 'receivable' ? 'Nova conta a receber' : 'Nova conta a pagar'} description="Valores e saldos são conciliados pelos lançamentos, sem apagar o histórico."><form key={editing?.id ?? `new-${mode}`} className="finance-form" noValidate onSubmit={saveAccount}>
      {formError}
      {mode === 'receivable' ? <label>Cliente<select name="clientId" required defaultValue={(editing as Receivable | null)?.clientId ?? prefillDraft?.clientId ?? ''}><option value="" disabled>Selecione</option>{receivables.options.clients.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : <label>Fornecedor / favorecido<input name="counterparty" required minLength={2} maxLength={160} defaultValue={(editing as Payable | null)?.counterparty ?? ''} /></label>}
      <label>Categoria<select name="categoryId" required defaultValue={editing?.categoryId ?? ''}><option value="" disabled>Selecione</option>{result.options.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="finance-form__wide">Descrição<input name="description" required minLength={2} maxLength={200} defaultValue={editing?.description ?? prefillDraft?.description ?? ''} /></label><label>Valor (R$)<input name="amount" required inputMode="decimal" value={composerAmountDraft} onChange={(e) => setComposerAmountDraft(e.target.value)} /></label><label>Vencimento<input name="dueOn" type="date" required defaultValue={editing?.dueOn.slice(0, 10) ?? today} /></label><label>Competência<input name="competenceMonth" type="month" required defaultValue={editing?.competenceOn.slice(0, 7) ?? today.slice(0, 7)} /></label>{!editing && <label className="finance-form__check"><input type="checkbox" checked={recurring} onChange={(event) => setRecurring(event.target.checked)} /> Repetir mensalmente</label>}{!editing && recurring && <label>Quantidade de parcelas<input name="installmentCount" type="number" required min={2} max={60} defaultValue={12} /></label>}
      {!editing && !recurring && (
        <label className="finance-form__check finance-form__wide">
          <input
            type="checkbox"
            checked={composerPayImmediately}
            onChange={(event) => {
              const checked = event.target.checked
              setComposerPayImmediately(checked)
              if (checked && composerPaymentParts.length === 0) {
                const total = cents(composerAmountDraft)
                const half = Math.floor(total / 2)
                setComposerPaymentParts([
                  { id: createUniqueId(), amount: (half / 100).toFixed(2).replace('.', ','), method: 'cash', externalReference: '' },
                  { id: createUniqueId(), amount: ((total - half) / 100).toFixed(2).replace('.', ','), method: 'credit_card', externalReference: '' },
                ])
              }
            }}
          />
          Registrar pagamento agora (já recebido no atendimento)
        </label>
      )}

      {!editing && !recurring && composerPayImmediately && (
        <div className="finance-split-section">
          <div className="finance-split-header">
            <div>
              <h3>Partes do pagamento</h3>
              <p>Registre como o cliente pagou esta cobrança.</p>
            </div>
            <label className="finance-form__check">
              <input
                type="checkbox"
                checked={composerSplitPayment}
                onChange={(event) => {
                  const checked = event.target.checked
                  setComposerSplitPayment(checked)
                  if (checked && composerPaymentParts.length === 0) {
                    const total = cents(composerAmountDraft)
                    const half = Math.floor(total / 2)
                    setComposerPaymentParts([
                      { id: createUniqueId(), amount: (half / 100).toFixed(2).replace('.', ','), method: 'cash', externalReference: '' },
                      { id: createUniqueId(), amount: ((total - half) / 100).toFixed(2).replace('.', ','), method: 'credit_card', externalReference: '' },
                    ])
                  }
                }}
              />
              Dividir pagamento em partes (ex: dinheiro + cartão)
            </label>
          </div>

          {!composerSplitPayment ? (
            <div className="finance-form finance-form__wide" style={{ margin: 0, padding: 0 }}>
              <label>
                Forma de pagamento
                <select name="composerMethod" required defaultValue="pix">
                  {Object.entries(methodLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label>
                Data e hora
                <input name="composerPaidAt" type="datetime-local" required defaultValue={currentDateTime} />
              </label>
              <label className="finance-form__wide">
                Referência externa (opcional)
                <input name="composerReference" maxLength={160} placeholder="Ex: Comprovante Pix ou recibo manual" />
              </label>
            </div>
          ) : (
            <>
              <div className="finance-split-header">
                <div className={`finance-split-counter ${composerPartsSumCents > composerTotalCents ? 'finance-split-counter--invalid' : 'finance-split-counter--valid'}`}>
                  {composerPartsSumCents > composerTotalCents
                    ? `Excede valor da conta em ${currency(composerPartsSumCents - composerTotalCents)}`
                    : composerRemainingCents === 0
                    ? `✓ Total: ${currency(composerPartsSumCents)} (quitação total)`
                    : `Soma: ${currency(composerPartsSumCents)} · Restante: ${currency(composerRemainingCents)}`}
                </div>
              </div>

              <ul className="finance-split-parts">
                {composerPaymentParts.map((part, index) => (
                  <li key={part.id} className="finance-split-part">
                    <label>
                      Valor parte {index + 1} (R$)
                      <input
                        required
                        inputMode="decimal"
                        value={part.amount}
                        onChange={(e) => updateComposerPaymentPart(part.id, { amount: e.target.value })}
                      />
                    </label>
                    <label>
                      Forma
                      <select
                        required
                        value={part.method}
                        onChange={(e) => updateComposerPaymentPart(part.id, { method: e.target.value as FinancialPaymentMethod })}
                      >
                        {Object.entries(methodLabels).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Referência (opcional)
                      <input
                        value={part.externalReference}
                        placeholder="Ex: Cartão Visa final 1234"
                        maxLength={160}
                        onChange={(e) => updateComposerPaymentPart(part.id, { externalReference: e.target.value })}
                      />
                    </label>
                    {composerPaymentParts.length > 1 && (
                      <button
                        type="button"
                        className="finance-split-remove"
                        title="Remover parte"
                        onClick={() => removeComposerPaymentPart(part.id)}
                      >
                        Remover
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              <div className="finance-split-actions">
                <Button type="button" variant="secondary" onClick={addComposerPaymentPart}>
                  + Adicionar forma de pagamento
                </Button>
                {composerRemainingCents > 0 && composerPaymentParts.length > 0 && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      const last = composerPaymentParts[composerPaymentParts.length - 1]
                      const curPartCents = cents(last.amount)
                      updateComposerPaymentPart(last.id, {
                        amount: ((curPartCents + composerRemainingCents) / 100).toFixed(2).replace('.', ','),
                      })
                    }}
                  >
                    Ajustar última parcela para completar ({currency(composerRemainingCents)})
                  </Button>
                )}
              </div>

              <label className="finance-form__wide">
                Data e hora
                <input name="composerPaidAt" type="datetime-local" required defaultValue={currentDateTime} />
              </label>
            </>
          )}
        </div>
      )}

      <div className="finance-form__actions"><Button type="submit" loading={saving} disabled={composerPayImmediately && composerSplitPayment && (composerPartsSumCents <= 0 || composerPartsSumCents > composerTotalCents)}>Salvar conta</Button><Button type="button" variant="secondary" disabled={saving} onClick={() => setComposerOpen(false)}>Cancelar</Button></div>
    </form></Card>}
    {paymentTarget && <Card title={mode === 'receivable' ? 'Registrar recebimento' : 'Registrar baixa'} description={`${paymentTarget.description} · saldo ${currency(paymentTarget.balanceCents)}`}><form className="finance-form" noValidate onSubmit={savePayment}>
      {formError}
      <label className="finance-form__check finance-form__wide">
        <input
          type="checkbox"
          checked={splitPayment}
          onChange={(e) => {
            const checked = e.target.checked
            setSplitPayment(checked)
            if (checked && paymentParts.length === 0) {
              const half = Math.floor(paymentTarget.balanceCents / 2)
              setPaymentParts([
                { id: createUniqueId(), amount: (half / 100).toFixed(2).replace('.', ','), method: 'cash', externalReference: '' },
                { id: createUniqueId(), amount: ((paymentTarget.balanceCents - half) / 100).toFixed(2).replace('.', ','), method: 'credit_card', externalReference: '' },
              ])
            }
          }}
        />
        Dividir pagamento em partes (ex: dinheiro + cartão)
      </label>

      {!splitPayment ? (
        <>
          <label>Valor (R$)<input name="amount" required inputMode="decimal" defaultValue={(paymentTarget.balanceCents / 100).toFixed(2).replace('.', ',')} /></label>
          <label>Forma<select name="method" required defaultValue="pix">{Object.entries(methodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Data e hora<input name="paidAt" type="datetime-local" required defaultValue={currentDateTime} /></label>
          <label>Referência externa (opcional)<input name="externalReference" maxLength={160} /></label>
        </>
      ) : (
        <div className="finance-split-section">
          <div className="finance-split-header">
            <div>
              <h3>Partes do pagamento</h3>
              <p>Informe o valor e a forma de cada parte recebida do cliente.</p>
            </div>
            <div className={`finance-split-counter ${partsSumCents > paymentTarget.balanceCents ? 'finance-split-counter--invalid' : 'finance-split-counter--valid'}`}>
              {partsSumCents > paymentTarget.balanceCents
                ? `Excede saldo em ${currency(partsSumCents - paymentTarget.balanceCents)}`
                : remainingBalanceCents === 0
                ? `✓ Total: ${currency(partsSumCents)} (quitação total)`
                : `Soma: ${currency(partsSumCents)} · Restante: ${currency(remainingBalanceCents)}`}
            </div>
          </div>

          <ul className="finance-split-parts">
            {paymentParts.map((part, index) => (
              <li key={part.id} className="finance-split-part">
                <label>
                  Valor parte {index + 1} (R$)
                  <input
                    required
                    inputMode="decimal"
                    value={part.amount}
                    onChange={(e) => updatePaymentPart(part.id, { amount: e.target.value })}
                  />
                </label>
                <label>
                  Forma
                  <select
                    required
                    value={part.method}
                    onChange={(e) => updatePaymentPart(part.id, { method: e.target.value as FinancialPaymentMethod })}
                  >
                    {Object.entries(methodLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Referência (opcional)
                  <input
                    value={part.externalReference}
                    placeholder="Ex: Cartão Visa final 1234"
                    maxLength={160}
                    onChange={(e) => updatePaymentPart(part.id, { externalReference: e.target.value })}
                  />
                </label>
                {paymentParts.length > 1 && (
                  <button
                    type="button"
                    className="finance-split-remove"
                    title="Remover parte"
                    onClick={() => removePaymentPart(part.id)}
                  >
                    Remover
                  </button>
                )}
              </li>
            ))}
          </ul>

          <div className="finance-split-actions">
            <Button type="button" variant="secondary" onClick={addPaymentPart}>
              + Adicionar forma de pagamento
            </Button>
            {remainingBalanceCents > 0 && paymentParts.length > 0 && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  const last = paymentParts[paymentParts.length - 1]
                  const curPartCents = cents(last.amount)
                  updatePaymentPart(last.id, {
                    amount: ((curPartCents + remainingBalanceCents) / 100).toFixed(2).replace('.', ','),
                  })
                }}
              >
                Ajustar última parcela para completar ({currency(remainingBalanceCents)})
              </Button>
            )}
          </div>

          <label className="finance-form__wide">
            Data e hora
            <input name="paidAt" type="datetime-local" required defaultValue={currentDateTime} />
          </label>
        </div>
      )}

      <div className="finance-form__actions"><Button type="submit" loading={saving} disabled={splitPayment && (partsSumCents <= 0 || partsSumCents > paymentTarget.balanceCents)}>Confirmar lançamento</Button><Button type="button" variant="secondary" onClick={() => setPaymentTarget(null)}>Cancelar</Button></div>
    </form></Card>}
    {cancelling && <Card title={`Cancelar ${cancelling.description}`} description="A conta continuará visível e não poderá ser reaberta neste fluxo."><form className="finance-cancel" noValidate onSubmit={cancelAccount}>{formError}<label>Motivo<textarea name="reason" required minLength={3} maxLength={200} /></label><div><Button type="submit" loading={saving}>Confirmar cancelamento</Button><Button type="button" variant="secondary" onClick={() => setCancelling(null)}>Voltar</Button></div></form></Card>}
    {reversal && <Card title="Confirmar estorno" description={`O lançamento original de ${currency(reversal.payment.amountCents)} será preservado.`}><form className="finance-cancel" noValidate onSubmit={reversePayment}>{formError}<label>Motivo<textarea name="reason" required minLength={3} maxLength={200} /></label><div><Button type="submit" loading={saving}>Registrar estorno</Button><Button type="button" variant="secondary" onClick={() => setReversal(null)}>Voltar</Button></div></form></Card>}
    {detail && <Card title={`Histórico · ${detail.description}`} description={`${'clientName' in detail ? detail.clientName : detail.counterparty} · vencimento ${localDate(detail.dueOn)}`}><dl className="finance-detail"><div><dt>Original</dt><dd>{currency(detail.originalAmountCents)}</dd></div><div><dt>Pago</dt><dd>{currency(detail.paidAmountCents)}</dd></div><div><dt>Saldo</dt><dd>{currency(detail.balanceCents)}</dd></div></dl><h3>Lançamentos</h3>{detail.payments?.length ? <ol className="finance-history">{detail.payments.map((payment) => <li key={payment.id}><strong>{payment.reversesPaymentId ? 'Estorno' : mode === 'receivable' ? 'Recebimento' : 'Baixa'} · {currency(payment.amountCents)}</strong><span>{methodLabels[payment.method]} · {new Date(payment.paidAt).toLocaleString('pt-BR')}</span>{canManage && !payment.reversesPaymentId && !payment.reversed && <Button type="button" variant="secondary" onClick={() => { setDetail(null); setReversal({ payment, record: detail }) }}>Estornar</Button>}</li>)}</ol> : <p>Nenhum lançamento registrado.</p>}<h3>Auditoria</h3>{detail.history?.length ? <ol className="finance-history">{detail.history.map((event) => <li key={event.id}><strong>{event.action}</strong><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString('pt-BR')}</time></li>)}</ol> : <p>Nenhuma alteração registrada.</p>}</Card>}
    <Card title={mode === 'receivable' ? 'Cobranças' : 'Despesas'} description="Situação e saldo são recalculados a partir do vencimento e dos lançamentos.">{canRead && <form className="finance-filter" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(searchDraft) }}><label>Buscar<input aria-label={mode === 'receivable' ? 'Buscar por cliente ou descrição' : 'Buscar por fornecedor ou descrição'} value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} /></label><label>Situação<select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as ReceivableStatus | '') }}><option value="">Todas</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><Button type="submit" variant="secondary">Buscar</Button></form>}
      {loading ? <LoadingState title="Carregando contas…" /> : !canRead ? <EmptyState title="Acesso restrito" description="Sua função não permite consultar o financeiro desta organização." /> : records.length === 0 ? <EmptyState title="Nenhuma conta encontrada" description="Ajuste os filtros ou cadastre a primeira conta." action={canManage ? <Button type="button" onClick={() => openComposer()}>Nova conta</Button> : undefined} /> : <ul className="receivable-list">{records.map((record) => <li key={record.id}><div><span><strong>{record.description}</strong><StatusBadge tone={record.status === 'paid' ? 'success' : record.status === 'overdue' ? 'warning' : 'neutral'}>{statusLabels[record.status]}</StatusBadge></span><p>{'clientName' in record ? record.clientName : record.counterparty} · {record.categoryName}</p><small>Vence {localDate(record.dueOn)}{record.installmentNumber ? ` · parcela ${record.installmentNumber}/${record.installmentCount}` : ''}</small></div><div className="receivable-list__amount"><strong>{currency(record.balanceCents)}</strong><small>de {currency(record.originalAmountCents)}</small></div><div className="receivable-list__actions"><Button type="button" variant="secondary" onClick={() => void showDetail(record)}>Histórico</Button>{canManage && !['cancelled', 'paid'].includes(record.status) && <Button type="button" onClick={() => openPayment(record)}>{mode === 'receivable' ? 'Receber' : 'Dar baixa'}</Button>}{canManage && !['cancelled', 'paid', 'partially_paid'].includes(record.status) && <><Button type="button" variant="secondary" onClick={() => openComposer(record)}>Editar</Button><Button type="button" variant="secondary" onClick={() => { resetPanels(); setCancelling(record) }}>Cancelar</Button></>}</div></li>)}</ul>}
      {canRead && result.pagination.totalPages > 1 && <nav className="finance-pagination" aria-label="Paginação de contas"><Button type="button" variant="secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</Button><span>Página {page} de {result.pagination.totalPages}</span><Button type="button" variant="secondary" disabled={page >= result.pagination.totalPages} onClick={() => setPage((value) => value + 1)}>Próxima</Button></nav>}
    </Card>
  </section>
}
