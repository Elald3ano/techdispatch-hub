import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  MapPin,
  Users,
} from 'lucide-react'
import type { Servicio, Tecnico } from '../../types'
import { esServicioLiviano } from '../../lib/tiposServicio'
import { limpiarTexto } from '../../lib/normalizer'
import { ciudadCanonica } from '../../lib/zonasPermitidas'
import { cn } from '../../lib/utils'
import { BarraProgreso, TarjetaAnalitica } from './TarjetaAnalitica'

// Referencia de saturación: a partir de 30 órdenes la barra llega al tope.
const REF_SATURACION = 30

type Carga = 'normal' | 'alta' | 'saturado'
type ModoVista = 'sucursales' | 'tecnicos'

interface ResumenTecnico {
  tecnico: Tecnico
  total: number
  livianos: number
  pesados: number
  carga: Carga
  ciudadesTexto: string
}

interface TecnicoSinOrdenes {
  tecnico: Tecnico
  ciudadesTexto: string
}

interface TecnicoEnCiudad {
  tecnicoId: string
  nombre: string
  total: number
  livianos: number
  pesados: number
  carga: Carga
}

interface ResumenCiudad {
  clave: string
  ciudad: string
  total: number
  sinAsignar: number
  tecnicos: TecnicoEnCiudad[]
}

function clasificarCarga(total: number): Carga {
  if (total > 25) return 'saturado'
  if (total >= 15) return 'alta'
  return 'normal'
}

const CARGA_CONFIG: Record<Carga, { barra: string; texto: string }> = {
  normal: { barra: 'bg-emerald-500', texto: 'text-emerald-300' },
  alta: { barra: 'bg-yellow-400', texto: 'text-yellow-300' },
  saturado: { barra: 'bg-red-500', texto: 'text-red-300' },
}

/**
 * Ciudades únicas legibles: priman las de las órdenes asignadas; si no hay,
 * se usan las asignadas en la regla territorial (`tecnicos_ciudades`).
 */
function formatearCiudades(deOrdenes: Set<string>, asignadas: string[] | undefined): string {
  const origen = deOrdenes.size > 0 ? [...deOrdenes] : (asignadas ?? [])
  const unicas = [...new Set(origen.map((c) => c.trim()).filter(Boolean))]
  return unicas.sort((a, b) => a.localeCompare(b)).join(', ')
}

interface BalanceCuadrillasProps {
  servicios: Servicio[]
  tecnicos: Tecnico[]
  ciudadesActivas: Record<string, string[]>
  tecnicosSeleccionadosIds: string[]
  sinAsignarCiudadSeleccionada: string | null
  onToggleTecnico: (id: string) => void
  onSeleccionarSinAsignarCiudad: (ciudad: string) => void
  onSeleccionarTodosDeCiudad: (ciudad: string) => void
  onDeseleccionarTodosDeCiudad: (ciudad: string) => void
  onLimpiarSeleccion: () => void
}

/** Balance y saturación de cuadrillas dentro del ámbito seleccionado. */
export function BalanceCuadrillas({
  servicios,
  tecnicos,
  ciudadesActivas,
  tecnicosSeleccionadosIds,
  sinAsignarCiudadSeleccionada,
  onToggleTecnico,
  onSeleccionarSinAsignarCiudad,
  onSeleccionarTodosDeCiudad,
  onDeseleccionarTodosDeCiudad,
  onLimpiarSeleccion,
}: BalanceCuadrillasProps) {
  const [modoVista, setModoVista] = useState<ModoVista>('sucursales')
  const [direccionOrden, setDireccionOrden] = useState<'desc' | 'asc'>('desc')

  const tecnicosPorId = useMemo(
    () => new Map(tecnicos.map((t) => [t.id, t] as const)),
    [tecnicos],
  )

  // Órdenes sin técnico asignado: siempre auditables desde el ranking.
  const totalSinAsignar = useMemo(
    () => servicios.filter((s) => s.tecnico_id === null).length,
    [servicios],
  )

  // Agrupación jerárquica por ciudad (vista "sucursales").
  const resumenCiudades = useMemo<ResumenCiudad[]>(() => {
    const factor = direccionOrden === 'asc' ? 1 : -1
    const porCiudad = new Map<
      string,
      {
        ciudad: string
        total: number
        sinAsignar: number
        porTecnico: Map<string, TecnicoEnCiudad>
      }
    >()

    for (const s of servicios) {
      const canonica = ciudadCanonica(s.ciudad) || s.ciudad
      const clave = limpiarTexto(canonica)
      if (!clave) continue
      let ciudad = porCiudad.get(clave)
      if (!ciudad) {
        ciudad = { ciudad: canonica, total: 0, sinAsignar: 0, porTecnico: new Map() }
        porCiudad.set(clave, ciudad)
      }
      ciudad.total += 1
      if (s.tecnico_id) {
        const tecnico = tecnicosPorId.get(s.tecnico_id)
        const prev = ciudad.porTecnico.get(s.tecnico_id) ?? {
          tecnicoId: s.tecnico_id,
          nombre: tecnico?.nombre ?? 'Técnico',
          total: 0,
          livianos: 0,
          pesados: 0,
          carga: 'normal' as Carga,
        }
        prev.total += 1
        if (esServicioLiviano(s.tipo_servicio)) prev.livianos += 1
        else prev.pesados += 1
        ciudad.porTecnico.set(s.tecnico_id, prev)
      } else {
        ciudad.sinAsignar += 1
      }
    }

    return [...porCiudad.values()]
      .map((c) => ({
        clave: limpiarTexto(c.ciudad),
        ciudad: c.ciudad,
        total: c.total,
        sinAsignar: c.sinAsignar,
        tecnicos: [...c.porTecnico.values()]
          .map((t) => ({ ...t, carga: clasificarCarga(t.total) }))
          .sort((a, b) => (a.total - b.total) * factor),
      }))
      .sort((a, b) => (a.total - b.total) * factor)
  }, [servicios, tecnicosPorId, direccionOrden])

  // Ranking plano por técnico (vista "tecnicos").
  const { ranking, sinOrdenes } = useMemo(() => {
    const factor = direccionOrden === 'asc' ? 1 : -1
    const acumulado = new Map<
      string,
      { tecnico: Tecnico; total: number; livianos: number; pesados: number; ciudades: Set<string> }
    >()

    for (const s of servicios) {
      if (!s.tecnico_id) continue
      const tecnico = tecnicosPorId.get(s.tecnico_id)
      if (!tecnico) continue
      const prev = acumulado.get(s.tecnico_id) ?? {
        tecnico,
        total: 0,
        livianos: 0,
        pesados: 0,
        ciudades: new Set<string>(),
      }
      prev.total += 1
      if (esServicioLiviano(s.tipo_servicio)) prev.livianos += 1
      else prev.pesados += 1
      if (s.ciudad) prev.ciudades.add(s.ciudad)
      acumulado.set(s.tecnico_id, prev)
    }

    const ranking: ResumenTecnico[] = [...acumulado.values()]
      .map((r) => ({
        tecnico: r.tecnico,
        total: r.total,
        livianos: r.livianos,
        pesados: r.pesados,
        carga: clasificarCarga(r.total),
        ciudadesTexto: formatearCiudades(r.ciudades, ciudadesActivas[r.tecnico.id]),
      }))
      .sort((a, b) => (a.total - b.total) * factor)

    const asignadosIds = new Set(acumulado.keys())
    const sinOrdenes: TecnicoSinOrdenes[] = tecnicos
      .filter((t) => t.activo && !asignadosIds.has(t.id))
      .map((t) => ({
        tecnico: t,
        ciudadesTexto: formatearCiudades(new Set<string>(), ciudadesActivas[t.id]),
      }))

    return { ranking, sinOrdenes }
  }, [servicios, tecnicos, ciudadesActivas, tecnicosPorId, direccionOrden])

  // Todas las ciudades comienzan colapsadas por defecto.
  const [sucursalExpandida, setSucursalExpandida] = useState<string | null>(null)

  function toggleSucursal(clave: string) {
    setSucursalExpandida((prev) => (prev === clave ? null : clave))
  }

  return (
    <TarjetaAnalitica
      icon={Users}
      titulo="Balance y Saturación de Cuadrillas"
      subtitulo={`${resumenCiudades.length} sucursales · ${ranking.length} técnicos`}
      accion={
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {tecnicosSeleccionadosIds.length > 0 && (
            <span className="inline-flex items-center gap-2 rounded-lg bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-200 ring-1 ring-cyan-500/30">
              {tecnicosSeleccionadosIds.length}{' '}
              {tecnicosSeleccionadosIds.length === 1
                ? 'técnico seleccionado'
                : 'técnicos seleccionados'}
              <button
                type="button"
                onClick={onLimpiarSeleccion}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-cyan-200/80 transition hover:bg-cyan-500/20 hover:text-white"
              >
                ✕ Limpiar
              </button>
            </span>
          )}
          <div className="flex gap-1 rounded-lg bg-white/5 p-1 ring-1 ring-white/10">
            <button
              type="button"
              onClick={() => setModoVista('sucursales')}
              aria-pressed={modoVista === 'sucursales'}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition',
                modoVista === 'sucursales'
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-slate-200',
              )}
            >
              <Building2 className="size-3.5" /> Por Sucursal
            </button>
            <button
              type="button"
              onClick={() => setModoVista('tecnicos')}
              aria-pressed={modoVista === 'tecnicos'}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition',
                modoVista === 'tecnicos'
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-slate-200',
              )}
            >
              <Users className="size-3.5" /> Ranking Técnicos
            </button>
          </div>

          {/* Orden por carga */}
          <button
            type="button"
            onClick={() => setDireccionOrden((d) => (d === 'desc' ? 'asc' : 'desc'))}
            aria-pressed={direccionOrden === 'asc'}
            title={
              direccionOrden === 'desc'
                ? 'Ordenar de mayor a menor carga'
                : 'Ordenar de menor a mayor carga'
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white"
          >
            {direccionOrden === 'desc' ? (
              <ArrowDown className="size-3.5" />
            ) : (
              <ArrowUp className="size-3.5" />
            )}
            {direccionOrden === 'desc' ? 'Mayor carga' : 'Menor carga'}
          </button>
        </div>
      }
    >
      {modoVista === 'sucursales' ? (
        /* ---- Vista por sucursal (acordeón jerárquico) ---- */
        <div>
          {resumenCiudades.length === 0 ? (
            <p className="text-xs text-slate-400">Sin órdenes en el ámbito seleccionado.</p>
          ) : (
            <ul className="space-y-1.5">
              {resumenCiudades.map((c) => {
                const expandida = sucursalExpandida === c.clave
                return (
                  <li
                    key={c.clave}
                    className="overflow-hidden rounded-lg bg-white/5 ring-1 ring-white/10"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSucursal(c.clave)}
                      aria-expanded={expandida}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-white/5"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {expandida ? (
                          <ChevronDown className="size-3.5 shrink-0 text-slate-400" />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0 text-slate-400" />
                        )}
                        <Building2 className="size-3.5 shrink-0 text-cyan-300" />
                        <span className="truncate text-sm font-medium text-slate-100">
                          {c.ciudad}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-xs font-semibold text-slate-200 ring-1 ring-white/15 tabular-nums">
                        {c.total}
                      </span>
                    </button>

                    {expandida && (
                      <div className="border-t border-white/10 p-2">
                        {c.sinAsignar > 0 && (
                          <button
                            type="button"
                            onClick={() => onSeleccionarSinAsignarCiudad(c.ciudad)}
                            aria-pressed={
                              tecnicosSeleccionadosIds.includes('sin_asignar') &&
                              sinAsignarCiudadSeleccionada === c.ciudad
                            }
                            className={cn(
                              'mb-2 flex w-full cursor-pointer items-center justify-between rounded-lg border p-2.5 text-left transition-all',
                              tecnicosSeleccionadosIds.includes('sin_asignar') &&
                                sinAsignarCiudadSeleccionada === c.ciudad
                                ? 'border-amber-500 bg-amber-950/40'
                                : 'border-amber-800/60 bg-amber-950/30 hover:bg-amber-950/50',
                            )}
                          >
                            <span className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                              <AlertTriangle className="size-4 text-amber-400" />
                              <span>Sin Asignar en {c.ciudad}</span>
                            </span>
                            <span className="rounded-full bg-amber-900/50 px-2 py-0.5 text-xs font-bold text-amber-400">
                              {c.sinAsignar}
                            </span>
                          </button>
                        )}
                        {c.tecnicos.length === 0 ? (
                          <p className="px-2.5 py-2 text-xs text-slate-500">
                            Sin técnicos con órdenes en esta ciudad.
                          </p>
                        ) : (
                          <>
                            <div className="mb-1.5 flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={() => onSeleccionarTodosDeCiudad(c.ciudad)}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-slate-800"
                              >
                                ☑️ Seleccionar todos en {c.ciudad}
                              </button>
                              <button
                                type="button"
                                onClick={() => onDeseleccionarTodosDeCiudad(c.ciudad)}
                                className="rounded-md border border-slate-600 px-2 py-1 text-[11px] font-medium text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
                              >
                                Desmarcar
                              </button>
                            </div>
                            <ul className="space-y-1">
                              {c.tecnicos.map((t) => {
                                const cfg = CARGA_CONFIG[t.carga]
                                const seleccionado = tecnicosSeleccionadosIds.includes(t.tecnicoId)
                                return (
                                  <li key={t.tecnicoId}>
                                    <button
                                      type="button"
                                      onClick={() => onToggleTecnico(t.tecnicoId)}
                                      aria-pressed={seleccionado}
                                      className={cn(
                                        'w-full rounded-lg px-2.5 py-2 text-left transition-all',
                                        seleccionado
                                          ? 'bg-cyan-500/10 ring-2 ring-cyan-400/70'
                                          : 'cursor-pointer hover:bg-slate-800/60',
                                      )}
                                    >
                                      <div className="mb-1 flex items-center justify-between gap-2">
                                        <div className="flex min-w-0 items-center gap-2">
                                          <span
                                            className={cn(
                                              'flex size-4 shrink-0 items-center justify-center rounded border transition',
                                              seleccionado
                                                ? 'border-cyan-400 bg-cyan-600'
                                                : 'border-slate-600 bg-slate-950',
                                            )}
                                          >
                                            {seleccionado && (
                                              <Check className="size-3 text-white" strokeWidth={3} />
                                            )}
                                          </span>
                                          <span className="truncate text-sm font-medium text-slate-200">
                                            {t.nombre}
                                          </span>
                                          {t.carga === 'saturado' && (
                                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-semibold text-red-300 ring-1 ring-red-500/30">
                                              <AlertTriangle className="size-3" /> Sobrecargado
                                            </span>
                                          )}
                                        </div>
                                        <span className={cn('text-sm font-bold tabular-nums', cfg.texto)}>
                                          {t.total}
                                        </span>
                                      </div>
                                      <BarraProgreso valor={t.total / REF_SATURACION} color={cfg.barra} />
                                      <p className="mt-1 text-[11px] text-slate-400">
                                        {t.livianos} liviano · {t.pesados} pesado
                                      </p>
                                    </button>
                                  </li>
                                )
                              })}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : (
        /* ---- Vista por técnico (ranking plano) ---- */
        <div>
          {ranking.length === 0 && totalSinAsignar === 0 ? (
            <p className="text-xs text-slate-400">Sin órdenes en el ámbito seleccionado.</p>
          ) : (
            <ul className="space-y-1.5">
              {totalSinAsignar > 0 && (
                <li>
                  <button
                    type="button"
                    onClick={() => onToggleTecnico('sin_asignar')}
                    aria-pressed={
                      tecnicosSeleccionadosIds.includes('sin_asignar') &&
                      sinAsignarCiudadSeleccionada === null
                    }
                    className={cn(
                      'w-full rounded-xl px-3 py-2 text-left transition-all',
                      tecnicosSeleccionadosIds.includes('sin_asignar') &&
                        sinAsignarCiudadSeleccionada === null
                        ? 'bg-amber-500/10 ring-2 ring-amber-400/70'
                        : 'cursor-pointer hover:bg-slate-800/60',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2 text-sm font-semibold text-amber-300">
                        <AlertTriangle className="size-3.5" />
                        Total Sin Asignar
                      </span>
                      <span className="text-sm font-bold text-amber-300 tabular-nums">
                        {totalSinAsignar}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-amber-200/70">
                      {totalSinAsignar} órdenes sin técnico asignado
                    </p>
                  </button>
                </li>
              )}
              {ranking.map((r) => {
                const cfg = CARGA_CONFIG[r.carga]
                const seleccionado = tecnicosSeleccionadosIds.includes(r.tecnico.id)
                return (
                  <li key={r.tecnico.id}>
                    <button
                      type="button"
                      onClick={() => onToggleTecnico(r.tecnico.id)}
                      aria-pressed={seleccionado}
                      className={cn(
                        'w-full rounded-xl px-3 py-2 text-left transition-all',
                        seleccionado
                          ? 'bg-cyan-500/10 ring-2 ring-cyan-400/70'
                          : 'cursor-pointer hover:bg-slate-800/60',
                      )}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={cn(
                              'flex size-4 shrink-0 items-center justify-center rounded border transition',
                              seleccionado
                                ? 'border-cyan-400 bg-cyan-600'
                                : 'border-slate-600 bg-slate-950',
                            )}
                          >
                            {seleccionado && (
                              <Check className="size-3 text-white" strokeWidth={3} />
                            )}
                          </span>
                          <span className="truncate text-sm font-medium text-slate-200">
                            {r.tecnico.nombre}
                          </span>
                          {r.carga === 'saturado' && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-semibold text-red-300 ring-1 ring-red-500/30">
                              <AlertTriangle className="size-3" /> Sobrecargado
                            </span>
                          )}
                        </div>
                        <span className={cn('text-sm font-bold tabular-nums', cfg.texto)}>
                          {r.total}
                        </span>
                      </div>
                      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-slate-400">
                        <MapPin className="size-3 shrink-0 text-cyan-400" />
                        <span className="truncate">
                          {r.ciudadesTexto || 'Sin ciudad asignada'} · {r.livianos} liviano ·{' '}
                          {r.pesados} pesado
                        </span>
                      </div>
                      <BarraProgreso valor={r.total / REF_SATURACION} color={cfg.barra} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {/* Técnicos en cero */}
      <div className="mt-4 border-t border-white/10 pt-3">
        <p className="text-xs font-semibold text-slate-300">Técnicos en cero hoy</p>
        {sinOrdenes.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">
            Todos los técnicos activos tienen órdenes asignadas.
          </p>
        ) : (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {sinOrdenes.map((t) => (
              <li
                key={t.tecnico.id}
                className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-slate-300 ring-1 ring-white/10"
              >
                {t.tecnico.nombre}
                {t.ciudadesTexto && (
                  <span className="text-slate-500"> · {t.ciudadesTexto}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </TarjetaAnalitica>
  )
}
