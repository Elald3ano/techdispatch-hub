import { useMemo, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { Servicio, Tecnico } from '../../types'
import type { ResultadoCierres } from '../../services/reconciliationService'
import { clasificarSla } from '../../lib/sla'
import { esGarantia, esPqrTecnica } from '../../lib/tiposServicio'
import { cn } from '../../lib/utils'
import { BarraProgreso, TarjetaAnalitica } from './TarjetaAnalitica'

interface ControlCalidadProps {
  servicios: Servicio[]
  tecnicos: Tecnico[]
  resultadoCierres: ResultadoCierres | null
}

type TabCalidad = 'criticas' | 'balance'

/** Control de calidad (Garantía/PQR) y salud del SLA. */
export function ControlCalidad({ servicios, tecnicos, resultadoCierres }: ControlCalidadProps) {
  const [tabActiva, setTabActiva] = useState<TabCalidad>('criticas')

  const data = useMemo(() => {
    const total = servicios.length
    const garantias = servicios.filter((s) => esGarantia(s.tipo_servicio)).length
    const pqr = servicios.filter((s) => esPqrTecnica(s.tipo_servicio)).length

    const alDia = servicios.filter((s) => clasificarSla(s.dias_antiguedad) === 'ok').length
    const preventivas = servicios.filter((s) => clasificarSla(s.dias_antiguedad) === 'warn').length
    const criticas = servicios.filter((s) => clasificarSla(s.dias_antiguedad) === 'critical').length

    // Órdenes críticas (3+ días) para la pestaña, de mayor a menor antigüedad.
    const criticasLista = servicios
      .filter((s) => clasificarSla(s.dias_antiguedad) === 'critical')
      .sort((a, b) => b.dias_antiguedad - a.dias_antiguedad)

    const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100))

    return { total, garantias, pqr, alDia, preventivas, criticas, criticasLista, pct }
  }, [servicios])

  // Balance de ciudades (descongestión) desde la auditoría de cierres.
  const balanceCiudades = useMemo(() => {
    if (!resultadoCierres) return []
    return [...resultadoCierres.balancePorCiudad].sort((a, b) => a.neto - b.neto)
  }, [resultadoCierres])

  const nombrePorId = useMemo(
    () => new Map(tecnicos.map((t) => [t.id, t.nombre] as const)),
    [tecnicos],
  )

  return (
    <TarjetaAnalitica
      icon={ShieldCheck}
      titulo="Control de Calidad y SLA"
      subtitulo="Garantías, PQR y salud del semáforo"
    >
      {/* Indicador de calidad */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-white/5 p-3 ring-1 ring-white/10">
          <p className="text-2xl font-bold text-white tabular-nums">{data.garantias}</p>
          <p className="text-[11px] text-slate-400">Garantías</p>
        </div>
        <div className="rounded-xl bg-white/5 p-3 ring-1 ring-white/10">
          <p className="text-2xl font-bold text-white tabular-nums">{data.pqr}</p>
          <p className="text-[11px] text-slate-400">PQR Técnica</p>
        </div>
      </div>

      {/* Salud del SLA */}
      <div className="space-y-2.5">
        <FilaSla label="Al día (1 día)" valor={data.alDia} pct={data.pct(data.alDia)} color="bg-emerald-500" />
        <FilaSla label="Preventivas (2 días)" valor={data.preventivas} pct={data.pct(data.preventivas)} color="bg-yellow-400" />
        <FilaSla label="Críticas (3+ días)" valor={data.criticas} pct={data.pct(data.criticas)} color="bg-red-500" />
      </div>

      {/* Sección inferior con pestañas */}
      <div className="mt-3 border-t border-white/10 pt-3">
        <div className="mb-2 flex gap-1 rounded-lg bg-white/5 p-1 ring-1 ring-white/10">
          <button
            type="button"
            onClick={() => setTabActiva('criticas')}
            aria-pressed={tabActiva === 'criticas'}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition',
              tabActiva === 'criticas'
                ? 'bg-slate-700 text-white'
                : 'text-slate-400 hover:text-slate-200',
            )}
          >
            🔥 Órdenes Críticas
          </button>
          <button
            type="button"
            onClick={() => setTabActiva('balance')}
            aria-pressed={tabActiva === 'balance'}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition',
              tabActiva === 'balance'
                ? 'bg-slate-700 text-white'
                : 'text-slate-400 hover:text-slate-200',
            )}
          >
            📉 Balance de Ciudades
          </button>
        </div>

        {tabActiva === 'criticas' ? (
          data.criticasLista.length === 0 ? (
            <p className="text-xs text-slate-500">
              Sin órdenes críticas en el ámbito seleccionado.
            </p>
          ) : (
            <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
              {data.criticasLista.map((s) => {
                const nombreTecnico = s.tecnico_id
                  ? (nombrePorId.get(s.tecnico_id) ?? null)
                  : null
                return (
                  <li key={s.id} className="rounded-lg bg-white/5 px-3 py-2 ring-1 ring-white/10">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-xs font-semibold text-slate-100">
                        {s.nombre_cliente || 'SIN NOMBRE'}
                      </p>
                      <span className="shrink-0 rounded-md bg-red-500/20 px-1.5 py-0.5 text-[10px] font-bold text-red-300 tabular-nums ring-1 ring-red-500/30">
                        {s.dias_antiguedad} días
                      </span>
                    </div>
                    <p className="truncate text-[11px] text-slate-400">
                      📍 {s.ciudad} ·{' '}
                      {nombreTecnico ? (
                        <span className="font-medium text-cyan-300">👤 {nombreTecnico}</span>
                      ) : (
                        <span className="font-medium text-amber-300">👤 ⚠️ Sin Asignar</span>
                      )}
                    </p>
                  </li>
                )
              })}
            </ul>
          )
        ) : balanceCiudades.length === 0 ? (
          <p className="text-xs text-slate-500">
            Audita dos cortes en la pestaña 'Auditoría de Cierres' para ver la tendencia de
            descongestión aquí.
          </p>
        ) : (
          <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {balanceCiudades.map((b) => (
              <li
                key={b.ciudad}
                className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2 ring-1 ring-white/10"
              >
                <span className="truncate text-xs font-medium text-slate-100">{b.ciudad}</span>
                <span
                  className={cn(
                    'shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold tabular-nums ring-1',
                    b.neto < 0
                      ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
                      : b.neto > 0
                        ? 'bg-red-500/15 text-red-300 ring-red-500/30'
                        : 'bg-slate-700 text-slate-300 ring-slate-600',
                  )}
                >
                  {b.neto < 0 ? `🟢 ${b.neto} netas` : b.neto > 0 ? `🔴 +${b.neto} netas` : '⚪ 0 netas'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </TarjetaAnalitica>
  )
}

function FilaSla({
  label,
  valor,
  pct,
  color,
}: {
  label: string
  valor: number
  pct: number
  color: string
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs text-slate-300">{label}</span>
        <span className="text-xs font-semibold text-slate-200 tabular-nums">
          {valor} · {pct}%
        </span>
      </div>
      <BarraProgreso valor={pct / 100} color={color} />
    </div>
  )
}
